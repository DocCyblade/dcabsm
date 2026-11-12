// The static HTTPS server the container layer points npm's registry, nodejs.org and GitHub at
// (spec 13.3). It serves files from <root>/<host>/<path> and nothing else.
// Usage: node test/container/mirror.ts <root> <cert.pem> <key.pem> [port] [address]
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The file a request maps to, or undefined when it would leave the root. */
export function mirrorPath(root: string, host: string, urlPath: string): string | undefined {
  const hostname = host.replace(/:\d+$/, "");
  if (!/^[a-z0-9.-]+$/i.test(hostname) || hostname.startsWith(".")) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split("?")[0] ?? "");
  } catch {
    return undefined;
  }
  const base = resolve(root);
  const file = resolve(join(base, hostname, path));
  return file.startsWith(base + sep) ? file : undefined;
}

function serve(root: string, cert: string, key: string, port: number, address: string): void {
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const file = mirrorPath(root, req.headers.host ?? "", req.url ?? "/");
    let size = -1;
    try {
      if (file !== undefined && statSync(file).isFile()) size = statSync(file).size;
    } catch {
      // Not there: a 404 below.
    }
    console.log(`${size < 0 ? 404 : 200} ${req.headers.host}${req.url}`);
    if (file === undefined || size < 0) {
      res.writeHead(404).end("not in the mirror\n");
      return;
    }
    res.writeHead(200, { "content-length": size });
    createReadStream(file).pipe(res);
  });
  server.listen(port, address, () => console.log(`mirror on :${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, cert, key, port, address] = process.argv.slice(2);
  if (!root || !cert || !key) {
    console.error(
      "Usage: node test/container/mirror.ts <root> <cert.pem> <key.pem> [port] [address]",
    );
    process.exit(2);
  }
  serve(root, cert, key, Number(port ?? 443), address ?? "0.0.0.0");
}
