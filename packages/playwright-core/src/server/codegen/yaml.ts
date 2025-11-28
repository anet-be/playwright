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
import * as YAML from 'js-yaml';
import { parseAttributeSelector, parseSelector, stringifySelector } from '../../utils/isomorphic/selectorParser';
import type { Language, LanguageGenerator, LanguageGeneratorOptions } from './types';
import type * as actions from '@recorder/actions';
import type {
  Element,
  Expectation,
  FrameRef,
  Modifier,
  Selector,
  SelectorFilters,
  TextMatcher,
} from './yamlTypes';

// Export YAML dump options for consistency between generator and tests
export const YAML_DUMP_OPTIONS: YAML.DumpOptions = {
  noRefs: true,
  lineWidth: 120,
  forceQuotes: true,
  quotingType: '"',
};

type ActionWithSelector = actions.Action & { selector?: string | null };


interface YamlDebugInfo {
  action_in_context?: actions.ActionInContext;
  parsed_selector?: {
    parsed?: ReturnType<typeof parseSelector>;
    baseIndex?: number;
    basePart?: any;
    warnings?: string[];
  };
  // Allow arbitrary extra debug fields
  [key: string]: unknown;
}


function parseTextSpec(input?: string): TextMatcher | undefined {
  if (!input)
    return undefined;

  function parseJsonString(q: string): string | undefined {
    try {
      const v = JSON.parse(q);
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  // Escape a string for literal use inside a RegExp
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Regex literal: /pattern/flags
  const rx = input.match(/^\/([\s\S]*)\/([dgimsuyv]*)$/);
  if (rx) {
    try {
      const rgx = new RegExp(rx[1], rx[2]);
      return { pattern: rgx.source, flags: rgx.flags };
    } catch {
      /* fall through */
    }
  }

  // Suffix forms: `"..."s` or `"..."i`
  //   `i`: case-insensitive
  //   `s`: case-sensitive
  if (input.endsWith('"s') || input.endsWith('"i')) {
    const suffix = input.at(-1)!;          // 's' | 'i'
    const quoted = input.slice(0, -1);     // keep the closing quote
    if (quoted.startsWith('"') && quoted.endsWith('"')) {
      const decoded = parseJsonString(quoted);
      if (decoded !== undefined) {
        if (suffix === 's') {
          // exact, case-sensitive
          return { value: decoded, exact: true };
        } else {
          // exact, case-insensitive → compile to ^text$ with /i
          return { pattern: `${escapeRegex(decoded)}`, flags: 'i' };
        }
      }
    }
  }

  // Plain quoted JSON string: `"..."`
  if (input.startsWith('"') && input.endsWith('"')) {
    const decoded = parseJsonString(input);
    if (decoded !== undefined)
      return decoded;
  }

  // Fallback: non-exact plain text
  return input;
}


function frameRefFromString(sel: string): FrameRef {
  const m = sel.match(/^frame\[name="(.+)"\]$/);
  if (m)
    return { name: m[1] };
  return { url_contains: sel }; // fallback
}


function framePathToObjects(path?: string[]): FrameRef[] | undefined {
  if (!path?.length)
    return undefined;
  return path.map(frameRefFromString);
}


function isActionWithSelector(action: actions.Action): action is ActionWithSelector {
  return 'selector' in action;
}


function buildStructuredSelector(actionInContext: actions.ActionInContext, debug?: YamlDebugInfo): Selector {
  const selector: Selector = {};

  const frame = actionInContext.frame;
  if (frame.pageAlias)
    selector.page = frame.pageAlias;
  const framePath = framePathToObjects(frame.framePath);
  if (framePath)
    selector.framePath = framePath;

  const action: actions.Action = actionInContext.action;
  if (isActionWithSelector(action)) {
    const raw = action.selector ?? undefined;
    const mapped = elementFromParsedSelector(raw, debug);
    selector.element = mapped?.element ?? { css: raw ?? 'UNKNOWN' };
    if (mapped?.filters)
      selector.filters = mapped.filters;
    if (typeof mapped?.nth === 'number')
      selector.nth = mapped.nth;
  }

  return selector;
}


// Simple default stripper
function stripDefaults<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined)
      continue;
    if (k === 'modifiers' && v === 0)
      continue;
    if (k === 'framePath' && Array.isArray(v) && v.length === 0)
      continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = stripDefaults(v as Record<string, unknown>);
      if (Object.keys(nested).length)
        out[k] = nested;
    } else { out[k] = v; }
  }
  return out as T;
}


function stripEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined)
      continue;
    if (Array.isArray(v)) {
      if (v.length)
        out[k] = v.map(x => (typeof x === 'object' && x !== null ? stripEmpty(x as Record<string, unknown>) : x));
      continue;
    }
    if (typeof v === 'object') {
      const nested = stripEmpty(v as Record<string, unknown>);
      if (Object.keys(nested).length)
        out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out as Partial<T>;
}


function formatAsYamlListItem(entry: unknown, dumpOpts: YAML.DumpOptions): string {
  const dumped = YAML.dump(entry, dumpOpts).replace(/\r\n?/g, '\n');
  const lines = dumped.endsWith('\n') ? dumped.slice(0, -1).split('\n') : dumped.split('\n');
  return lines.map((line, i) => (i === 0 ? `  - ${line}` : `    ${line}`)).join('\n') + '\n';
}


// Mask values that look like passwords
function matchText(t: TextMatcher): boolean {
  const rx = /password|pwd|secret/i;
  if (typeof t === 'string')
    return rx.test(t);
  if ('value' in t && typeof t.value === 'string' && rx.test(t.value))
    return true;
  if ('pattern' in t && typeof t.pattern === 'string' && rx.test(t.pattern))
    return true;
  return false;
}


function maybeMaskValue(el: Element | undefined, text: string | undefined): string | undefined {
  if (!el)
    return text
  if (text === null || text === undefined)
    return text;

  // testId or label or placeholder containing "password"/"pwd"/"secret"
  if ('testId' in el && /password|pwd|secret/i.test(el.testId))
    return '${env:ANET_PASSWORD}';
  if ('label' in el && matchText(el.label))
    return '${env:ANET_PASSWORD}';
  if ('placeholder' in el && matchText(el.placeholder))
    return '${env:ANET_PASSWORD}';
  if ('role' in el && /password|pwd|secret/i.test((el as any).name ?? ''))
    return '${env:ANET_PASSWORD}';
  if ('text' in el && matchText(el.text))
    return '${env:ANET_PASSWORD}';
  if ('css' in el && /password|pwd|secret/i.test(el.css))
    return '${env:ANET_PASSWORD}';
  if ('xpath' in el && /password|pwd|secret/i.test(el.xpath))
    return '${env:ANET_PASSWORD}';

  return text;
}


function decodeModifiers(mask: number | undefined): Modifier[] | undefined {
  if (!mask)
    return undefined;

  const result: Modifier[] = [];
  if (mask & 1)
    result.push('Alt');
  if (mask & 2)
    result.push('Control');
  if (mask & 4)
    result.push('Meta');
  if (mask & 8)
    result.push('Shift');

  return result.length ? result : undefined;
}


// URLs we consider noise for the first step
const TRIVIAL_URL_PREFIXES = [
  'about:blank',
  'chrome-error://',
  'devtools://',
  'edge://',
  'data:',
  'blob:',
  'chrome-extension://',
];


function isTrivialUrl(url?: string): boolean {
  if (!url)
    return true;
  return TRIVIAL_URL_PREFIXES.some(p => url.startsWith(p));
}

interface ParsedSelectorResult {
  element: Element;
  filters?: SelectorFilters;
  nth?: number;
}

function elementFromParsedSelector(raw?: string, debug?: YamlDebugInfo): ParsedSelectorResult | undefined {
  if (!raw)
    return undefined;

  let parsed: ReturnType<typeof parseSelector>;
  try {
    parsed = parseSelector(raw);
  } catch {
    return undefined;
  }

  // Pick the captured part if present (what Playwright intends as the target).
  let baseIndex: number;
  const FILTER_ENGINES = new Set([
    'internal:has-text',
    'internal:has-not-text',
    'internal:has',
    'internal:has-not',
    'visible',
    'nth',
  ]);
  const IGNORE_ENGINES = new Set(['internal:describe']);

  if (typeof parsed.capture === 'number' && parsed.capture >= 0) {
    baseIndex = parsed.capture;
  } else {
    // walk from the end to find the last non-filter engine,
    baseIndex = -1;
    for (let i = parsed.parts.length - 1; i >= 0; i--) {
      const name = parsed.parts[i]?.name;
      if (!name)
        continue;
      if (IGNORE_ENGINES.has(name))
        continue;
      if (!FILTER_ENGINES.has(name)) {
        baseIndex = i;
        break;
      }
    }

    // Fallback: if we never found a non-filter, non-ignored part,
    // just point at the last part and let the default case handle it.
    if (baseIndex === -1)
      baseIndex = parsed.parts.length - 1;
  }

  // If we still landed on an ignored engine (e.g. captured describe),
  // walk backwards until we hit something real or give up.
  while (baseIndex >= 0 && IGNORE_ENGINES.has(parsed.parts[baseIndex]?.name))
    baseIndex--;

  if (baseIndex < 0) {
    // Nothing usable — treat as a raw css-ish selector.
    return { element: { css: raw } };
  }

  // Base part (element) comes from baseIndex
  let basePart = parsed.parts[baseIndex];
  if (debug) {
    const ps = debug.parsed_selector ?? (debug.parsed_selector = { parsed });
    ps.baseIndex = baseIndex;
    ps.basePart = basePart;
  }

  // Map basePart onto our structures
  if (!basePart)
    return { element: { css: raw } };


  const element: Record<string, unknown> = {};

  switch (basePart.name) {
    // case 'internal:and': {}
    // case 'internal:or': {}
    // case 'internal:chain': {}
    // case 'internal:control': {}

    case 'internal:testid': {
      // Example body: `"login-password"`
      const attrSelector = parseAttributeSelector(basePart.body as string, true);
      const { value } = attrSelector.attributes[0];
      element.testId = value;
      break;
    }

    case 'internal:role': {
      // Example body: `button[name="Submit"i][include-hidden]`
      //                or `textbox[name=/Email/i][level=3]`
      const attrSelector = parseAttributeSelector(basePart.body as string, true);
      element.role = attrSelector.name;

      for (const attr of attrSelector.attributes) {
        const name = attr.name;

        // Helper: turn attribute into boolean-ish value
        const asBool = (): boolean | undefined => {
          if (attr.op === '<truthy>')
            return true;
          const v = attr.value;
          if (typeof v === 'boolean')
            return v;
          if (typeof v === 'string') {
            const s = v.toLowerCase();
            if (s === 'true')
              return true;
            if (s === 'false')
              return false;
          }
          return undefined;
        };

        switch (name) {
          case 'name': {
            const v = attr.value;

            let matcher: TextMatcher | undefined;

            if (v instanceof RegExp) {
              // Playwright parsed a real regex for the accessible name.
              matcher = { pattern: v.source, flags: v.flags };
            } else if (v !== null && v !== undefined) {
              const s = String(v);
              if (attr.caseSensitive) {
                // Exact, case-sensitive accessible name.
                matcher = { value: s, exact: true };
              } else {
                // Non-exact / case-insensitive-ish name → plain string.
                matcher = s;
              }
            }

            if (matcher !== undefined)
              (element as any).name = matcher;

            break;
          }

          case 'include-hidden': {
            const v = asBool();
            if (v !== undefined)
              element.include_hidden = v;
            break;
          }

          case 'level': {
            const raw = attr.value;
            const n = typeof raw === 'number' ? raw : Number(raw);
            if (Number.isFinite(n))
              element.level = n;
            break;
          }

          case 'checked':
          case 'pressed':
          case 'selected':
          case 'expanded':
          case 'disabled': {
            const v = asBool();
            if (v !== undefined) {
              // Use the attribute name directly as the field name on element
              (element as any)[name] = v;
            } else if (typeof attr.value === 'string') {
              // e.g. checked="mixed" – keep the raw string if your schema allows it
              (element as any)[name] = attr.value;
            }
            break;
          }

          default: {
            // Any extra role attributes we don't know about yet
            if (debug && debug.parsed_selector) {
              (debug.parsed_selector.warnings ??= [])
                .push(`unhandled internal:role attribute [${name}]`);
            }
            break;
          }
        }
      }
      break;
    }

    case 'internal:text': {
      // Example body: `"Sign in"` or `/Sign\s+in/i`
      element.text = parseTextSpec(basePart.body as string | undefined);
      break;
    }

    case 'css':
    case 'css:light': {
      // TODO: map the "body" object?
      element.css = basePart.source;
      break;
    }

    case 'xpath': {
      element.xpath = basePart.source;
      break;
    }

    case 'internal:label': {
      // Example body: `"Email"` or `/E-mail/i`
      element.label = parseTextSpec(basePart.body as string | undefined);
      break;
    }

    case 'internal:placeholder': {
      element.placeholder = parseTextSpec(basePart.body as string | undefined);
      break;
    }

    case 'internal:attr': {
      // Example body: `[alt="Logo"]`, `[title="Tooltip"]` or `[placeholder="Search"]`
      const attrSelector = parseAttributeSelector(basePart.body as string, true);
      const first = attrSelector.attributes[0];
      if (!first) {
        // Fall back to the previous behaviour: stringify the whole selector.
        element.css = stringifySelector(parsed);
        if (debug && debug.parsed_selector) {
          (debug.parsed_selector.warnings ??= [])
            .push('internal:attr without attributes');
        }
        break;
      }

      const attrName = first.name.toLowerCase();
      const body = String(basePart.body ?? '');

      // Try to recover the original textual value (`"Text"`, `/re/i`, etc.).
      let rawValueSource: string | undefined;
      const m = body.match(/=\s*(.+)\s*\]$/);
      if (m)
        rawValueSource = m[1];

      const textMatcher = rawValueSource ? parseTextSpec(rawValueSource) : undefined;
      const value = textMatcher ?? first.value;

      switch (attrName) {
        case 'alt':
          (element as any).alt = value;
          break;
        case 'title':
          (element as any).title = value;
          break;
        case 'placeholder':
          (element as any).placeholder = value;
          break;
        default:
          // Unknown attribute name: degrade gracefully to css selector.
          element.css = stringifySelector(parsed);
          if (debug && debug.parsed_selector) {
            (debug.parsed_selector.warnings ??= [])
              .push(`unhandled internal:attr attribute [${attrName}]`);
          }
          break;
      }
      break;
    }

    default: {
      // Unknown engine (internal:has, spatial filters, etc.) — stringify to something stable
      element.css = stringifySelector(parsed);
      if (debug && debug.parsed_selector)
        (debug.parsed_selector.warnings ??= []).push(`unhandled engine ${basePart.name}`);
    }
  }

  // Everything after baseIndex are post-filters/position
  let filters: Partial<SelectorFilters> | undefined;
  let nth: number | undefined;
  for (const part of parsed.parts.slice(baseIndex + 1)) {
    if (!part || part.name === 'internal:describe')
      continue;

    switch (part.name) {
      case 'internal:has-text': {
        (filters ??= {}).hasText = parseTextSpec(part.body as string | undefined);
        break;
      }

      case 'internal:has-not-text': {
        (filters ??= {}).hasNotText = parseTextSpec(part.body as string | undefined);
        break;
      }

      case 'visible': {
        // Playwright normalizes things like filter(,visible=true/false).
        // Treat "false" explicitly, everything else → true.
        const raw = (part.body ?? 'true') as string;
        const s = String(raw).trim().toLowerCase();
        (filters ??= {}).visible = s !== 'false';
        break;
      }

      case 'internal:has': {
        // body is a NestedSelectorBody: { parsed: ParsedSelector, distance?: number }
        const nestedParsed = (part.body as Record<string, unknown>)?.parsed;
        if (nestedParsed) {
          const nestedRaw = stringifySelector(nestedParsed as any);
          const nested = elementFromParsedSelector(nestedRaw);
          if (nested)
            (filters ??= {}).has = nested;

        }
        break;
      }

      case 'internal:has-not': {
        const nestedParsed = (part.body as Record<string, unknown>)?.parsed;
        if (nestedParsed) {
          const nestedRaw = stringifySelector(nestedParsed as any);
          const nested = elementFromParsedSelector(nestedRaw);
          if (nested)
            (filters ??= {}).hasNot = nested;

        }
        break;
      }

      case 'nth': {
        const n = parseInt(String(part.body ?? ''), 10);
        if (Number.isFinite(n))
          nth = n;
        break;
      }

      default: {
        if (debug && debug.parsed_selector) {
          (debug.parsed_selector.warnings ??= [])
            .push(`unhandled parsed attribute part ${part?.name}`);
        }
        break;
      }
    }
  }

  return { element: element as Element, filters, nth };
}


type UrlHint =
  | { url_exact: string }
  | { url_contains: string };


function expectFromSignals(action: actions.Action): Expectation[] | undefined {

  function toUrlHint(url?: string): UrlHint | undefined {
    if (!url)
      return undefined;
    try {
      const u = new URL(url);
      // exact for absolute http(s), contains otherwise
      return u.protocol === 'http:' || u.protocol === 'https:'
        ? { url_exact: url }
        : { url_contains: url };
    } catch {
      return { url_contains: url };
    }
  }

  const signals = action?.signals;
  if (!Array.isArray(signals) || signals.length === 0)
    return undefined;

  const expectations: Expectation[] = [];

  for (const signal of signals as actions.Signal[]) {
    switch (signal.name) {
      case 'navigation': {
        const hint = toUrlHint(signal.url);
        expectations.push(
          hint ? { expect: 'navigation', ...hint } : { expect: 'navigation' }
        );
        break;
      }
      case 'popup': {
        expectations.push({ expect: 'popup', pageAlias: signal.popupAlias });
        break;
      }
      case 'download': {
        expectations.push({ expect: 'download' });
        break;
      }
      case 'dialog': {
        expectations.push({ expect: 'dialog' });
        break;
      }
      default:
        // ignore unknown signals
        break;
    }
  }

  return expectations.length ? expectations : undefined;
}


export class YamlLanguageGenerator implements LanguageGenerator {
  id = 'yaml';
  groupName = 'Genfest';
  name = 'YAML';
  highlighter = 'javascript' as Language;

  private _dumpOpts = YAML_DUMP_OPTIONS;
  private _headerEmitted = false;
  private _seedUrl: string | undefined;
  private _meta: { version: string; name: string; baseURL?: string } = {
    version: '0.2',
    name: 'Recorded Scenario',
  };
  private _debug = false;

  private _emitHeaderOnce(): string[] {
    if (this._headerEmitted)
      return [];
    this._headerEmitted = true;

    // Dump only the meta (no steps), then add "steps:"; from now on we'll append list items.
    const metaDump = YAML.dump(stripEmpty(this._meta), this._dumpOpts).replace(/\r\n?/g, '\n');
    const metaNoTrail = metaDump.endsWith('\n') ? metaDump.slice(0, -1) : metaDump;

    return [
      metaNoTrail,
      'steps:',
      '', // blank line for readability
    ];
  }

  generateHeader(options: LanguageGeneratorOptions): string {
    // Little hack to turn on debug info in the generated yaml
    if (process.env.GENFEST_HTML_DIR)
      this._debug = true;

    // Derive defaults early so header can include them.
    this._seedUrl = options?.contextOptions?.baseURL || undefined;
    this._meta.name = (this._seedUrl ? new URL(this._seedUrl).hostname : 'Recorded Scenario');
    this._meta.baseURL = options?.contextOptions?.baseURL || this._seedUrl;
    this._headerEmitted = false;
    return '# Generated by Genfest';
  }

  generateAction(actionInContext: actions.ActionInContext): string {
    const out: string[] = [];

    let debug: YamlDebugInfo | undefined = undefined;
    if (this._debug)
      debug = { action_in_context: actionInContext };

    const selector = buildStructuredSelector(actionInContext, debug);

    const step: Record<string, unknown> = {};

    const action = actionInContext.action;
    switch (action.name) {

      // --- navigate ----------------------------------------------
      // --- openPage ----------------------------------------------
      case 'openPage':
      case 'navigate': {
        const url = action.url;
        // Skip trivial URLs
        if (isTrivialUrl(url))
          return out.join('\n');

        // Extract origin as baseURL from first non-trivial URL
        if (!this._meta.baseURL) {
          try {
            this._meta.baseURL = new URL(url).origin;
          } catch {
            // If URL parsing fails, use the full URL as fallback
            this._meta.baseURL = url;
          }
        }
        if (!this._headerEmitted)
          out.push(...this._emitHeaderOnce());

        step.action = 'navigate';

        // Make URL relative if it shares the same origin as baseURL
        let outputUrl = url;
        if (this._meta.baseURL && url) {
          try {
            const baseUrl = new URL(this._meta.baseURL);
            const targetUrl = new URL(url);

            // If same origin (protocol + host + port), make it relative
            if (baseUrl.origin === targetUrl.origin) {
              outputUrl = targetUrl.pathname + targetUrl.search + targetUrl.hash;
            }
          } catch {
            // If URL parsing fails, keep the original URL
            outputUrl = url;
          }
        }

        step.url = outputUrl;
        break;
      }

      // --- click -------------------------------------------------
      case 'click': {
        if (action.clickCount === 2) {
          step.action = 'dblclick';
        } else {
          step.action = 'click';
          if (action.clickCount !== 1)
            step.clickCount = action.clickCount;
        }
        step.button = action.button;
        step.modifiers = decodeModifiers(action.modifiers);
        step.expectations = expectFromSignals(action);
        break;
      }

      // --- fill --------------------------------------------------
      case 'fill': {
        step.action = 'fill';
        step.text = maybeMaskValue(selector.element, action.text);
        step.expectations = expectFromSignals(action);
        break;
      }

      // --- press -------------------------------------------------
      case 'press': {
        step.action = 'press';
        step.key = action.key;
        step.modifiers = decodeModifiers(action.modifiers);
        step.expectations = expectFromSignals(action);
        break;
      }

      // --- check -------------------------------------------------
      case 'check': {
        step.action = 'check';
        step.expectations = expectFromSignals(action);
        break;
      }

      // --- uncheck -----------------------------------------------
      case 'uncheck': {
        step.action = 'uncheck';
        step.expectations = expectFromSignals(action);
        break;
      }

      // --- assertText --------------------------------------------
      case 'assertText': {
        step.action = 'assert.text';
        step.text = action.text;
        break;
      }

      // --- assertValue -------------------------------------------
      case 'assertValue': {
        step.action = 'assert.value';
        step.value = action.value;
        break;
      }

      // --- assertVisible -----------------------------------------
      case 'assertVisible': {
        step.action = 'assert.visible';
        if ((action as any).isNot)
          step.visible = false;

        break;
      }

      // --- assertChecked -----------------------------------------
      case 'assertChecked': {
        step.action = 'assert.checked';
        step.checked = action.checked;
        break;
      }

      // --- closePage ---------------------------------------------
      case 'closePage': {
        step.action = 'closePage';
        break;
      }

      // --- select ------------------------------------------------
      case 'select': {
        step.action = 'select';
        // Playwright's SelectAction always provides options as string[]
        step.options = action.options.map(opt => ({ value: opt }));
        step.expectations = expectFromSignals(action);
        break;
      }

      // --- setInputFiles -----------------------------------------
      // --- assertSnapshot ----------------------------------------
      default: {
        step.action = action.name + ' (NOT SUPPORTED)';
        if (!this._debug)
          step.debug = { action_in_context: actionInContext };
        break;
      }
    }

    step.selector = selector;
    if (this._debug)
      step.debug = debug;

    out.push(formatAsYamlListItem(stripDefaults(step), this._dumpOpts));
    return out.join('\n');
  }

  // Nothing to flush at the end; the document was streamed.
  generateFooter(_saveStorage: string | undefined): string {
    return '';
  }
}
