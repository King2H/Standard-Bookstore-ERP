import { readFileSync } from 'node:fs';

// The bookstore's one version (#245, owner decision 3a) is the root
// package.json's. The install's build writes it into the bundle
// (deploy/Dockerfile, --define); from the source tree it is read there.
declare const __BMS_VERSION__: string | undefined;

function fromSourceTree(): string {
  const root = new URL('../../../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(root, 'utf8')) as { version: string }).version;
}

export const APP_VERSION: string = typeof __BMS_VERSION__ === 'string' ? __BMS_VERSION__ : fromSourceTree();
