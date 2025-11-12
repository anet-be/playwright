import * as YAML from 'js-yaml';
import type { Language, LanguageGenerator, LanguageGeneratorOptions } from './types';
import { parseAttributeSelector, parseSelector, stringifySelector } from '../../utils/isomorphic/selectorParser';
import type * as actions from '@recorder/actions';


type TextMatcher =
  | string
  | { value: string; exact: boolean }
  | { pattern: string; flags: string };


function parseTextSpec(input?: string): TextMatcher | undefined {
  if (!input) return undefined;

  function parseJsonString(q: string): string | undefined {
    try {
      const v = JSON.parse(q);
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  // Escape a string for literal use inside a RegExp
  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        if (suffix === "s") {
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


function frameRefFromString(sel: string) {
  const m = sel.match(/^frame\[name="(.+)"\]$/);
  if (m) return { name: m[1] as string };
  return { selector: sel }; // fallback
}


function framePathToObjects(path?: string[]) {
  if (!path?.length) return undefined;
  return path.map(frameRefFromString);
}


function isActionWithSelector(action: any): action is actions.ActionWithSelector {
  return action && (action as any)?.selector;
}


function buildStructuredSelector(actionInContext: actions.ActionInContext, debug: Record<string, any> | undefined): any {
  const selector: Record<string, any> = {};

  const frame = actionInContext.frame
  if (frame.pageAlias) selector.page = frame.pageAlias;
  const framePath = framePathToObjects(frame.framePath);
  if (framePath) selector.framePath = framePath;

  const action: actions.Action = actionInContext.action;
  if (isActionWithSelector(action)) {
    const raw = action.selector;
    const mapped = elementFromParsedSelector(raw, debug);
    selector.element = mapped?.element ?? { css: raw ?? 'UNKNOWN' };
    if (mapped?.filters) selector.filters = mapped.filters;
    if (typeof mapped?.nth === 'number') selector.nth = mapped.nth;
  }

  return selector;
}


// Simple default stripper
function stripDefaults<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (k === 'modifiers' && v === 0) continue;
    if (k === 'framePath' && Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const nested = stripDefaults(v as any);
      if (Object.keys(nested).length) out[k] = nested;
    } else out[k] = v;
  }
  return out;
}


function stripEmpty<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length) out[k] = v.map(x => (typeof x === 'object' ? stripEmpty(x as any) : x));
      continue;
    }
    if (typeof v === 'object') {
      const nested = stripEmpty(v as any);
      if (Object.keys(nested).length) out[k] = nested;
      continue;
    }
    out[k] = v;
  }
  return out;
}


function formatAsYamlListItem(entry: unknown, dumpOpts: any): string {
  const dumped = YAML.dump(entry, dumpOpts).replace(/\r\n?/g, '\n');
  const lines = dumped.endsWith('\n') ? dumped.slice(0, -1).split('\n') : dumped.split('\n');
  return lines.map((line, i) => (i === 0 ? `  - ${line}` : `    ${line}`)).join('\n') + '\n';
}


// Mask values that look like passwords
function matchText(t: string | { value: string; regex?: string; exact?: boolean }): boolean {
  if (typeof t === 'string') return /password|pwd|secret/i.test(t);
  if (t.value && /password|pwd|secret/i.test(t.value)) return true;
  if (t.regex && /password|pwd|secret/i.test(t.regex)) return true;
  return false;
}


function maybeMaskValue(el: any, text: string | undefined): string | undefined {
  if (text == null) return text;

  // testId or label or placeholder containing "password"/"pwd"/"secret"
  if ('testId' in el && /password|pwd|secret/i.test(el.testId)) return '${env:ANET_PASSWORD}';
  if ('label' in el && matchText(el.label)) return '${env:ANET_PASSWORD}';
  if ('placeholder' in el && matchText(el.placeholder)) return '${env:ANET_PASSWORD}';
  if ('role' in el && /password|pwd|secret/i.test(el.name ?? '')) return '${env:ANET_PASSWORD}';
  if ('text' in el && matchText(el.text)) return '${env:ANET_PASSWORD}';
  if ('css' in el && /password|pwd|secret/i.test(el.css)) return '${env:ANET_PASSWORD}';
  if ('xpath' in el && /password|pwd|secret/i.test(el.xpath)) return '${env:ANET_PASSWORD}';

  return text;
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
  if (!url) return true;
  return TRIVIAL_URL_PREFIXES.some(p => url.startsWith(p));
}


function elementFromParsedSelector(raw?: string, debug?: Record<string, any>): { element: any; filters?: any; nth?: number } | undefined {
  if (!raw) return undefined;

  let parsed: ReturnType<typeof parseSelector>;
  try {
    parsed = parseSelector(raw);
  } catch {
    return undefined;
  }

  if (debug) debug.parsed_selector = { parsed: parsed };

  // Pick the captured part if present (what Playwright intends as the target).
  let baseIndex: number;
  const FILTER_ENGINES = new Set(['internal:has-text', 'internal:has', 'nth']);
  if (typeof parsed.capture === 'number' && parsed.capture >= 0) {
    baseIndex = parsed.capture;
  } else {
    // walk from the end to find the last non-filter engine
    baseIndex = parsed.parts.length - 1;
    for (let i = parsed.parts.length - 1; i >= 0; i--) {
      if (!FILTER_ENGINES.has(parsed.parts[i]?.name)) {
        baseIndex = i;
        break;
      }
    }
  }

  // Base part (element) comes from baseIndex
  if (debug) debug.parsed_selector.baseIndex = baseIndex;
  const basePart = parsed.parts[baseIndex];
  if (debug) debug.parsed_selector.basePart = basePart;

  // Map basePart onto our structures
  if (!basePart) {
    return { element: { css: raw } };
  }

  const element: Record<string, any> = {};

  switch (basePart.name) {
    // case 'internal:describe': {}
    // case 'visible': {}
    // case 'internal:has-not-text': {}
    // case 'internal:has': {}
    // case 'internal:has-not': {}
    // case 'internal:and': {}
    // case 'internal:or': {}
    // case 'internal:chain': {}
    // case 'internal:attr': {}
    // case 'internal:control': {}

    case 'internal:testid': {
      // Example body: `"login-password"`
      const attrSelector = parseAttributeSelector(basePart.body as string, true);
      const { value } = attrSelector.attributes[0];
      element.testId = value;
      break;
    }

    case 'internal:role': {
      // Example body: `button[name="Submit"i]` or `textbox[name=/Email/i]`
      const attrSelector = parseAttributeSelector(basePart.body as string, true);
      element.role = attrSelector.name;
      for (const attr of attrSelector.attributes) {
        if (attr.name === 'name') {
          element.name = attr.value;
          // TODO: Not making use of `caseSensitive`
          // The recorder usually gives back role[name="text"i] with `i` meaning case case-insensitive
          // element.exact = attr.caseSensitive;
        } else {
          // TODO: we ignore all other options...
          // See locatorGenerators.ts:151
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

    default: {
      // Unknown engine (internal:has, spatial filters, etc.) — stringify to something stable
      element.css = stringifySelector(parsed);
      if (debug) (debug.parsed_selector.warnings ??= []).push(`unhandled engine ${basePart.name}`);
    }
  }

  // Everything after baseIndex are post-filters/position
  let filters: any | undefined;
  let nth: number | undefined;
  for (const part of parsed.parts.slice(baseIndex + 1)) {
    switch (part?.name) {
      case 'internal:has-text': {
        (filters ??= {}).hasText = parseTextSpec(part.body as string | undefined);
        break;
      }
      case 'nth': {
        const n = parseInt(String(part.body ?? ''), 10);
        if (Number.isFinite(n)) nth = n;
        break;
      }
      default: {
        if (debug) (debug.parsed_selector.warnings ??= []).push(`unhandled parsed attribute part ${part?.name}`);
        break;
      }
    }
  }

  return { element, filters, nth }
}


type UrlHint =
  | { url_exact: string }
  | { url_contains: string };


type Expectation =
  | ({ expect: "navigation" } & Partial<UrlHint>)
  | { expect: "popup"; pageAlias?: string }
  | { expect: "download" }
  | { expect: "dialog"; type?: "alert" | "beforeunload" | "confirm" | "prompt" }; // extend if you record message/accepted


function expectFromSignals(action: actions.Action): Expectation[] | undefined {

  function toUrlHint(url?: string): UrlHint | undefined {
    if (!url) return undefined;
    try {
      const u = new URL(url);
      // exact for absolute http(s), contains otherwise
      return u.protocol === "http:" || u.protocol === "https:"
        ? { url_exact: url }
        : { url_contains: url };
    } catch {
      return { url_contains: url };
    }
  }

  const signals = action?.signals;
  if (!Array.isArray(signals) || signals.length === 0) return undefined;

  const expectations: Expectation[] = [];

  for (const signal of signals as actions.Signal[]) {
    switch (signal.name) {
      case "navigation": {
        const hint = toUrlHint(signal.url);
        expectations.push(
          hint ? { expect: "navigation", ...hint } : { expect: "navigation" }
        );
        break;
      }
      case "popup": {
        expectations.push({ expect: "popup", pageAlias: signal.popupAlias });
        break;
      }
      case "download": {
        expectations.push({ expect: "download" });
        break;
      }
      case "dialog": {
        // If you capture dialog type/message/accepted, add them here
        expectations.push({ expect: "dialog" });
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

  private _dumpOpts = { noRefs: true, lineWidth: 120, forceQuotes: true };
  private _headerEmitted = false;
  private _seedUrl: string | undefined;
  private _meta: { version: string; name: string; baseURL?: string } = {
    version: '0.2',
    name: 'Recorded Scenario',
  };
  private _debug = false;

  private _emitHeaderOnce(): string[] {
    if (this._headerEmitted) return [];
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
    if (process.env.GENFEST_HTML_DIR) this._debug = true;

    // Derive defaults early so header can include them.
    this._seedUrl = options?.contextOptions?.baseURL || undefined;
    this._meta = {
      version: '0.1',
      name: (this._seedUrl ? new URL(this._seedUrl).hostname : 'Recorded Scenario'),
      baseURL: options?.contextOptions?.baseURL || this._seedUrl,
    };
    this._headerEmitted = false;
    return '# Generated by Genfest'
  }

  generateAction(actionInContext: actions.ActionInContext): string {
    const out: string[] = [];

    let debug: Record<string, any> | undefined = undefined;
    if (this._debug) debug = { action_in_context: actionInContext };

    const selector = buildStructuredSelector(actionInContext, debug);

    const step: Record<string, any> = {};

    const action = actionInContext.action;
    switch (action.name) {

      // --- navigate ----------------------------------------------
      // --- openPage ----------------------------------------------
      case 'openPage':
      case 'navigate': {
        const url = action.url;
        // Skip trivial URLs
        if (isTrivialUrl(url)) return out.join('\n');

        if (!this._meta.baseURL) this._meta.baseURL = url;
        if (!this._headerEmitted) out.push(...this._emitHeaderOnce());

        step.action = 'navigate';
        step.url = url;
        break;
      }

      // --- click -------------------------------------------------
      case 'click': {
        step.action = (action.clickCount === 2) ? 'dblclick' : 'click';
        step.button = action.button;
        step.modifiers = action.modifiers;
        if (action.clickCount !== 1) step.clickCount = action.clickCount;
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
        step.modifiers = action.modifiers;
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
        break;
      }

      // --- assertChecked -----------------------------------------
      case 'assertChecked': {
        step.action = 'assertChecked';
        step.checked = action.checked;
        break;
      }

      // --- closePage ---------------------------------------------
      case 'closePage': {
        step.action = 'closePage';
        break;
      }

      // --- select ------------------------------------------------
      // --- setInputFiles -----------------------------------------
      // --- assertSnapshot ----------------------------------------
      default: {
        step.action = action.name + " (NOT SUPPORTED)"
        if (!this._debug) step.debug = { action_in_context: actionInContext };
        break;
      }
    }

    step.selector = selector;
    if (this._debug) step.debug = debug;

    out.push(formatAsYamlListItem(stripDefaults(step), this._dumpOpts));
    return out.join('\n');
  }

  // Nothing to flush at the end; the document was streamed.
  generateFooter(saveStorage: string | undefined): string {
    return '';
  }
}
