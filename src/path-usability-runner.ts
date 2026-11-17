import { fstatSync, openSync, closeSync } from 'node:fs';

let fd: number | undefined;
try {
  fd = openSync('.', 'r');
  const stat = fstatSync(fd, { bigint: true });
  process.stdout.write(`${stat.dev.toString()} ${stat.ino.toString()}\n`);
} finally {
  if (fd !== undefined) closeSync(fd);
}
