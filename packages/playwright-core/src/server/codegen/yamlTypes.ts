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

/**
 * Type definitions for Genfest YAML scenario format.
 * Based on scenario.schema.json from the Genfest project.
 */

// Text matcher types (schema line 91-140)
export type TextMatcher =
  | string
  | { value: string; exact: boolean }
  | { pattern: string; flags?: string };

// Button types (schema line 141-148)
export type Button = 'left' | 'right' | 'middle';

// Modifier types (schema line 149-160)
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

// Role element (schema line 161-220)
export interface RoleElement {
  role: string;
  name?: TextMatcher;
  exact?: boolean;
  checked?: boolean | 'mixed';
  pressed?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  includeHidden?: boolean;
  level?: number;
}

// Element selector types (schema line 222-335)
export type Element =
  | { testId: string }
  | { css: string }
  | RoleElement
  | { text: TextMatcher }
  | { label: TextMatcher }
  | { placeholder: TextMatcher }
  | { alt: TextMatcher }
  | { title: TextMatcher }
  | { xpath: string };

// Frame reference types (schema line 337-407)
export type FrameRef =
  | { name: string; kind?: 'auto' | 'iframe' | 'frame' | 'object' }
  | { url_exact: string; kind?: 'auto' | 'iframe' | 'frame' | 'object' }
  | { url_contains: string; kind?: 'auto' | 'iframe' | 'frame' | 'object' }
  | { index: number; kind?: 'auto' | 'iframe' | 'frame' | 'object' };

// Selector filters (schema line 408-428)
export interface SelectorFilters {
  hasText?: TextMatcher;
  hasNotText?: TextMatcher;
  visible?: boolean;
  has?: Selector;
  hasNot?: Selector;
}

// Selector (schema line 429-454)
export interface Selector {
  page?: string;
  framePath?: FrameRef[];
  element?: Element;
  filters?: SelectorFilters;
  nth?: number;
}

// Select option types (schema line 877-922)
export type SelectOption =
  | { value: string }
  | { label: string }
  | { index: number };

// Expectation types (schema line 787-876)
export type Expectation =
  | { expect: 'navigation'; url_exact?: string; url_contains?: string }
  | { expect: 'popup'; pageAlias?: string; url_exact?: string; url_contains?: string }
  | { expect: 'download' }
  | { expect: 'dialog'; type?: 'alert' | 'beforeunload' | 'confirm' | 'prompt'; message?: TextMatcher; accepted?: boolean };

// Base step properties
export interface BaseStep {
  action: string;
  description?: string;
  timeout?: number;
  retry?: number;
  debug?: Record<string, unknown>;
}

// Step types based on actions (schema line 455-785)
export type Step =
  | (BaseStep & { action: 'navigate'; url: string; selector?: Selector })
  | (BaseStep & { action: 'click'; selector: Selector; button?: Button; modifiers?: Modifier[]; clickCount?: number; expectations?: Expectation[] })
  | (BaseStep & { action: 'dblclick'; selector: Selector; button?: Button; modifiers?: Modifier[]; expectations?: Expectation[] })
  | (BaseStep & { action: 'fill'; selector: Selector; text: string; expectations?: Expectation[] })
  | (BaseStep & { action: 'press'; selector: Selector; key: string; expectations?: Expectation[] })
  | (BaseStep & { action: 'check'; selector: Selector; expectations?: Expectation[] })
  | (BaseStep & { action: 'uncheck'; selector: Selector; expectations?: Expectation[] })
  | (BaseStep & { action: 'select'; selector: Selector; options: SelectOption[]; expectations?: Expectation[] })
  | (BaseStep & { action: 'hover'; selector: Selector })
  | (BaseStep & { action: 'closePage'; selector: Selector })
  | (BaseStep & { action: 'assert.text'; selector: Selector; text: TextMatcher })
  | (BaseStep & { action: 'assert.value'; selector: Selector; value: string })
  | (BaseStep & { action: 'assert.checked'; selector: Selector; checked?: boolean })
  | (BaseStep & { action: 'assert.visible'; selector: Selector; visible?: boolean });

// Scenario (schema line 4-84)
export interface Scenario {
  version: string;
  name: string;
  description?: string;
  tags?: string[];
  baseURL?: string;
  vars?: Record<string, string>;
  hooks?: {
    before?: string[];
    after?: string[];
  };
  steps: Step[];
}
