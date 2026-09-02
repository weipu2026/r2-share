/**
 * files.json 索引读写 + 路径安全校验
 *
 * 设计要点：
 * 1. 索引本身也存在 R2 里（公开可读），前端直接 fetch 渲染，目录页因此零 Worker 消耗
 * 2. 更新走增量（读 → 改 → 写），不做全量重建，避免超出免费版 10ms CPU 限制
 * 3. 所有路径必须过 sanitizePath，挡住 ../ 穿越与控制字符
 */

export interface FileEntry {
  /** 相对路径，如 "文档/报告.pdf" */
  p: string;
  /** 字节大小 */
  s: number;
  /** 上传时间戳（毫秒） */
  t: number;
  /** MIME 类型 */
  c: string;
}

export interface FileIndex {
  updated: number;
  files: FileEntry[];
}

const INDEX_KEY = 'files.json';

/**
 * 索引更新的互斥锁：upsertFile / removeFile 都是「读 → 改 → 写」三步，
 * 并发请求会读到同一份旧索引、互相覆盖（丢更新）。用模块级 promise 链
 * 把索引写操作串行化。零依赖，Workers 单 isolate 内天然有效。
 */
let indexLock: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = indexLock.then(fn, fn);
  indexLock = run.catch(() => {});
  return run;
}

/**
 * 规范化并校验用户提交的路径。
 * 返回 null 表示路径非法。
 */
export function sanitizePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let p = input.trim();

  // 拒绝绝对路径：R2 的 key 一律是相对的，开头带 / 或 \ 说明意图可疑
  if (/^[/\\]/.test(p)) return null;

  // 统一成正斜杠，去掉首尾斜杠
  p = p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return null;

  // 拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;

  // 逐段检查
  const segs = p.split('/');
  for (const seg of segs) {
    if (!seg) return null; // 空段（连续斜杠）
    if (seg === '.' || seg === '..') return null; // 路径穿越
    if (seg.length > 255) return null;
  }

  // R2 对象 key 上限 1024 字节，留余量按 900 字节校验（中文字符 UTF-8 占 3 字节）
  if (new TextEncoder().encode(p).length > 900) return null;

  return segs.join('/');
}

/** 读取索引；不存在或损坏时返回空索引 */
export async function readIndex(bucket: R2Bucket): Promise<FileIndex> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) return { updated: 0, files: [] };
  try {
    const data = (await obj.json()) as FileIndex;
    if (!data || !Array.isArray(data.files)) {
      return { updated: 0, files: [] };
    }
    return data;
  } catch {
    return { updated: 0, files: [] };
  }
}

export async function writeIndex(
  bucket: R2Bucket,
  index: FileIndex
): Promise<void> {
  index.updated = Date.now();
  await bucket.put(INDEX_KEY, JSON.stringify(index), {
    httpMetadata: {
      contentType: 'application/json; charset=utf-8',
      // 索引会被频繁读取，缓存 10 秒保证上传后能较快看到新文件
      cacheControl: 'public, max-age=10',
    },
  });
}

/** 新增或更新一条记录（增量，不重建整个索引） */
export async function upsertFile(
  bucket: R2Bucket,
  entry: FileEntry
): Promise<void> {
  await withIndexLock(async () => {
    const index = await readIndex(bucket);
    const i = index.files.findIndex((f) => f.p === entry.p);
    if (i >= 0) index.files[i] = entry;
    else index.files.push(entry);
    await writeIndex(bucket, index);
  });
}

/** 删除一条记录 */
export async function removeFile(
  bucket: R2Bucket,
  path: string
): Promise<boolean> {
  return withIndexLock(async () => {
    const index = await readIndex(bucket);
    const next = index.files.filter((f) => f.p !== path);
    if (next.length === index.files.length) return false;
    index.files = next;
    await writeIndex(bucket, index);
    return true;
  });
}

/**
 * 递归删除目录：删掉 path/ 前缀下的所有对象 + 占位对象本身，
 * 同时把索引里以 path/ 开头的条目（含占位条目）全部移除。
 * 返回删除的对象个数（不含占位对象）。
 */
export async function removeDir(
  bucket: R2Bucket,
  path: string
): Promise<number> {
  return withIndexLock(async () => {
    const prefix = path + '/';
    let cursor: string | undefined;
    let n = 0;
    do {
      const page = await bucket.list({ prefix, cursor, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) {
        await bucket.delete(keys);
        // 占位对象（key === prefix）不计入文件数，否则空目录会显示「含 1 个文件」
        n += keys.filter((k) => k !== prefix).length;
      }
      cursor = page.truncated
        ? (page as unknown as { cursor?: string }).cursor
        : undefined;
    } while (cursor);

    // 占位对象（新建目录时创建的 <dir>/ 0 字节对象）
    await bucket.delete(prefix);

    const index = await readIndex(bucket);
    const next = index.files.filter(
      (f) => f.p !== prefix && !f.p.startsWith(prefix)
    );
    if (next.length !== index.files.length) {
      index.files = next;
      await writeIndex(bucket, index);
    }
    return n;
  });
}

/**
 * 全量重建索引：遍历桶内所有对象（跳过 files.json 自身）。
 * 适用场景：用 rclone / CF 后台直接传了文件，增量索引对不上真实内容。
 * list 的等待时间不计入 CPU，JSON 组装对几千个文件也足够轻，
 * 免费版 10ms CPU 限定内可支撑数千个对象。
 */
export async function rebuildIndex(
  bucket: R2Bucket
): Promise<{ files: number }> {
  const files: FileEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      if (o.key === INDEX_KEY) continue;
      files.push({
        p: o.key,
        s: o.size,
        t: o.uploaded.getTime(),
        c: guessType(o.key),
      });
    }
    cursor = page.truncated
      ? (page as unknown as { cursor?: string }).cursor
      : undefined;
  } while (cursor);
  await writeIndex(bucket, { updated: 0, files });
  return { files: files.length };
}

/** 常见扩展名 → MIME，猜不出来时回退到 octet-stream */
export function guessType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    wav: 'audio/wav',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    '7z': 'application/x-7z-compressed',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    epub: 'application/epub+zip',
    apk: 'application/vnd.android.package-archive',
    exe: 'application/vnd.microsoft.portable-executable',
    dmg: 'application/x-apple-diskimage',
  };
  return map[ext] ?? 'application/octet-stream';
}
