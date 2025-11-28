/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { debugLogger } from './debugLogger';
import type { Page } from '../page';
import type { Frame } from '../frames';

export function scheduleDumpFrameTree(page: Page, name: string): void {
  const outDir = process.env.GENFEST_HTML_DIR;
  if (!outDir)
    return;
  setImmediate(() => {
    dumpFrameTree(page, outDir, name).catch(e =>
      debugLogger.log('browser', `[dumpFrameTree] error: ${e}`)
    );
  });
}

export async function dumpFrameTree(page: Page, outDir: string, name: string) {
  await fs.mkdir(outDir, { recursive: true });

  // Build a stable, short, safe slug from the current page URL.
  const url = page.mainFrame().url();
  const base = `${name}_${urlSlug(url)}_${shortHash(url || name)}`;

  await dump(page.mainFrame(), 'main');

  async function dump(frame: Frame, label: string) {
    try {
      const html = await frame.content();
      const file = path.join(outDir, `${base}_${label}.html`);
      await fs.writeFile(file, html);
    } catch (err) {
      debugLogger.log('browser', `dump ${label} failed: ${err}`);
    }
    await Promise.all(
        frame.childFrames().map((c, i) => dump(c, `${label}-child${i}`))
    );
  }
}

// --- helpers ---

function urlSlug(raw: string): string {
  // Make a concise, filesystem-safe slug from a URL.
  // host + last 3 path segments + first 2 query keys, all sanitized.
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/\./g, '-');

    const parts = u.pathname.split('/').filter(Boolean);
    const tail = parts.slice(-3).join('_');

    const qsKeys = Array.from(new URLSearchParams(u.search).keys())
        .slice(0, 2)
        .join('_');

    const combined = [host, tail, qsKeys].filter(Boolean).join('_') || 'root';
    return sanitize(combined, 90);
  } catch {
    // Not a valid URL (about:blank, data:, or empty): just sanitize the raw
    return sanitize(raw || 'page', 60);
  }
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

function sanitize(s: string, max = 100): string {
  return s
      .replace(/[^a-zA-Z0-9._-]/g, '-') // safe chars
      .replace(/-+/g, '-')              // collapse dashes
      .replace(/^[-.]+|[-.]+$/g, '')    // trim edge punctuation
      .slice(0, max) || 'page';
}
