import "./style.css";
import "./zod-strict-csp.js";

import { sourceContentHash } from "@walk-me-through-code/contracts";
import type {
  Annotation,
  ConversationMode,
  ContextSelectionItem,
  ExplanationModule,
  RestrictedMarkdown,
  SourceReference,
  WalkthroughArtifact,
} from "@walk-me-through-code/contracts";

type Theme = "system" | "light" | "dark";
type SessionState = "created" | "viewer_open" | "agent_listening" | "active" | "ending" | "ended" | "interrupted";

declare global {
  interface Window {
    readonly WMTCViewer: {
      reconnectEvents(): void;
      refreshArtifact(): Promise<void>;
    };
  }
}

interface QuestionView {
  readonly artifactRevision: number;
  readonly context: ContextSelectionItem[] | null;
  readonly id: string;
  readonly message: string;
  readonly mode: ConversationMode;
  readonly queuePosition: number;
  readonly state: "queued" | "leased" | "acknowledged" | "answered" | "cancelled" | "failed";
}

interface DraftView {
  readonly artifactRevision: number;
  readonly context: ContextSelectionItem[] | null;
  readonly draftPosition: number;
  readonly id: string;
  readonly message: string;
  readonly mode: ConversationMode;
  readonly updatedAt: string;
}

interface StatusView {
  readonly id: string;
  readonly questionId: string;
  readonly status: string;
}

interface ReplyView {
  readonly id: string;
  readonly content: unknown;
  readonly outcome: "answer" | "failure";
  readonly questionId: string;
}

interface SessionView {
  readonly drafts: readonly DraftView[];
  readonly events: readonly Pick<ConversationDurableEvent, "id" | "sequence" | "type">[];
  readonly questions: readonly QuestionView[];
  readonly replies: readonly ReplyView[];
  readonly session: {
    readonly conversationMode: ConversationMode;
    readonly id: string;
    readonly state: SessionState;
  };
  readonly statuses: readonly StatusView[];
  readonly walkthroughUpdateOutcomes?: readonly {
    readonly questionId: string;
    readonly outcome: WalkthroughUpdateOutcome;
  }[];
}

interface ConversationDurableEvent {
  readonly data?: {
    readonly draft?: DraftView;
    readonly mode?: ConversationMode;
    readonly to?: SessionState;
  };
  readonly entityId: string;
  readonly id: string;
  readonly record?: QuestionView | ReplyView | StatusView;
  readonly sequence: number;
  readonly type: string;
  readonly walkthroughUpdate?: WalkthroughUpdateOutcome;
}

interface WalkthroughUpdateOutcome {
  readonly changedIds?: readonly string[];
  readonly currentRevision?: number;
  readonly error?: {
    readonly currentRevision: number;
    readonly expectedRevision: number;
    readonly message: string;
    readonly recoverable: boolean;
  };
  readonly status: "applied" | "rejected";
  readonly updateId: string;
}

class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

interface SourceLineSelection {
  readonly endLine: number;
  readonly file: string;
  readonly startLine: number;
  readonly targetId: string;
}

type TextRangeSelection = Extract<ContextSelectionItem, { kind: "textRange" }>;

interface TextContextTarget {
  readonly field: string;
  readonly targetId: string;
}

interface TextNodeSourceMap {
  readonly offsets: readonly number[];
  readonly source: string;
  readonly spans: readonly InlineSourceSpan[];
}

const selectedModules = new Set<string>();
const selectedTextRanges = new Map<string, TextRangeSelection>();
const selectedSourceLineRanges = new Map<string, SourceLineSelection>();
const linkedTextRanges = new Map<string, TextRangeSelection>();
const walkthroughUpdateOutcomes = new Map<string, WalkthroughUpdateOutcome>();
let currentArtifact: WalkthroughArtifact | undefined;
let lineSelectionAnchor: {
  readonly line: number;
  readonly rangeKey?: string;
  readonly targetId: string;
} | undefined;
let contextSelectionAvailable = true;
let selectionChanged = (): void => undefined;
let contextSelectionGeneration = 0;
let conversationAvailabilityChanged = (): void => undefined;
let conversationEventApply: (event: ConversationDurableEvent) => Promise<void> = () => Promise.resolve();
let sessionEventSource: EventSource | undefined;
let sessionEventProcessing = Promise.resolve();
let sessionEventReconnectTimer: number | undefined;
let reconnectSessionEvents = (): void => undefined;
const textNodeSourceMaps = new WeakMap<Text, TextNodeSourceMap>();

interface ConversationStudioView {
  readonly conversation: HTMLElement;
  readonly focusComposer: () => void;
  readonly reconcileMode: () => void;
  readonly refresh: () => Promise<boolean>;
}

let persistentConversationStudio: ConversationStudioView | undefined;

function userSelectionChanged(): void {
  contextSelectionGeneration += 1;
  selectionChanged();
}

const app = document.querySelector<HTMLElement>("#WMTC-viewer-app");

function paintSessionChrome(state: SessionState): void {
  const ended = state === "ending" || state === "ended";
  const status = document.querySelector<HTMLElement>(".status-pill");
  if (status !== null) {
    status.textContent = ended ? "Ended" : "Ready";
    status.dataset.state = ended ? "ended" : "active";
  }
  const endButton = document.querySelector<HTMLButtonElement>(".end-session-button");
  if (endButton !== null) {
    endButton.disabled = ended;
    endButton.textContent = ended ? "Session ended" : "End session";
  }
  if (ended) {
    const outcome = document.querySelector<HTMLElement>(".end-session-outcome");
    if (outcome !== null) outcome.textContent = "Session ended.";
  }
}

// Artifact IDs are lowercase by contract, so this uppercase namespace can never collide with them.
function viewerDomId(id: string): string {
  return `WMTC-viewer-${id}`;
}

function artifactDomId(id: string): string {
  return `WMTC-artifact-${id}`;
}

function headingDomId(id: string): string {
  return `WMTC-heading-${id}`;
}

function lineDomId(moduleId: string, lineNumber: number): string {
  return `WMTC-line-${moduleId}-${lineNumber}`;
}

function textRangeDomId(targetId: string, field: string): string {
  return `WMTC-text-${targetId}-${field.replaceAll(".", "-")}`;
}

function linkedTextRangeDomId(selection: TextRangeSelection): string {
  const identity = JSON.stringify([
    selection.targetId,
    selection.field,
    selection.startOffset,
    selection.endOffset,
    selection.selectedText,
  ]);
  return `WMTC-text-range-${sourceContentHash(identity).slice("sha256:".length)}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className !== undefined) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

interface InlineSourceMap {
  readonly offsets: readonly number[];
  readonly source: string;
  readonly spans: readonly InlineSourceSpan[];
  readonly start: number;
}

interface InlineSourceSpan {
  readonly endOffset: number;
  readonly startOffset: number;
}

function normalizeMarkdownSource(source: string): {
  readonly offsets: readonly number[];
  readonly value: string;
} {
  const offsets = [0];
  let sourceCodePointOffset = 0;
  let value = "";
  for (let sourceIndex = 0; sourceIndex < source.length;) {
    if (source[sourceIndex] === "\r" && source[sourceIndex + 1] === "\n") {
      value += "\n";
      sourceCodePointOffset += 2;
      sourceIndex += 2;
      offsets.push(sourceCodePointOffset);
      continue;
    }
    const character = String.fromCodePoint(source.codePointAt(sourceIndex) ?? 0);
    value += character;
    sourceCodePointOffset += 1;
    sourceIndex += character.length;
    for (let index = 0; index < character.length; index += 1) offsets.push(sourceCodePointOffset);
  }
  return { offsets, value };
}

function appendMappedText(
  parent: Node,
  text: string,
  mapping?: InlineSourceMap,
  relativeStart = 0,
): void {
  const node = document.createTextNode(text);
  if (mapping !== undefined) {
    const start = mapping.start + relativeStart;
    textNodeSourceMaps.set(node, {
      offsets: mapping.offsets.slice(start, start + text.length + 1),
      source: mapping.source,
      spans: mapping.spans,
    });
  }
  parent.appendChild(node);
}

function inlineTokenMapping(
  mapping: InlineSourceMap | undefined,
  contentStart: number,
  tokenStart: number,
  tokenEnd: number,
): InlineSourceMap | undefined {
  if (mapping === undefined) return undefined;
  const absoluteTokenStart = mapping.start + tokenStart;
  const absoluteTokenEnd = mapping.start + tokenEnd;
  const startOffset = mapping.offsets[absoluteTokenStart];
  const endOffset = mapping.offsets[absoluteTokenEnd];
  if (startOffset === undefined || endOffset === undefined) return undefined;
  return {
    offsets: mapping.offsets,
    source: mapping.source,
    spans: [...mapping.spans, { startOffset, endOffset }],
    start: mapping.start + contentStart,
  };
}

function appendInline(parent: HTMLElement, source: string, mapping?: InlineSourceMap): void {
  const tokenPattern = /(`+)([^`]+)\1|\*\*([^*]+)\*\*|(?<!\*)\*([^*]+)\*(?!\*)|\[([^\]]+)]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index;
    if (index > cursor) appendMappedText(parent, source.slice(cursor, index), mapping, cursor);
    if (match[2] !== undefined) {
      const code = element("code", "inline-code");
      const contentStart = index + (match[1]?.length ?? 0);
      appendMappedText(code, match[2], inlineTokenMapping(
        mapping,
        contentStart,
        index,
        index + match[0].length,
      ));
      parent.append(code);
    } else if (match[3] !== undefined) {
      const strong = element("strong");
      appendInline(strong, match[3], inlineTokenMapping(
        mapping,
        index + 2,
        index,
        index + match[0].length,
      ));
      parent.append(strong);
    } else if (match[4] !== undefined) {
      const emphasis = element("em");
      appendInline(emphasis, match[4], inlineTokenMapping(
        mapping,
        index + 1,
        index,
        index + match[0].length,
      ));
      parent.append(emphasis);
    } else if (match[5] !== undefined && match[6] !== undefined) {
      let url: URL | undefined;
      try {
        const candidate = new URL(match[6], window.location.origin);
        if (candidate.protocol === "http:" || candidate.protocol === "https:") url = candidate;
      } catch {
        // A schema-valid Markdown destination can still be malformed for the URL parser.
      }
      const labelMapping = inlineTokenMapping(
        mapping,
        index + 1,
        index,
        index + match[0].length,
      );
      if (url === undefined) {
        const label = element("span");
        appendMappedText(label, match[5], labelMapping);
        parent.append(label);
      } else {
        const link = element("a");
        appendMappedText(link, match[5], labelMapping);
        link.href = url.href;
        if (url.origin !== window.location.origin) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        parent.append(link);
      }
    }
    cursor = index + match[0].length;
  }
  if (cursor < source.length) appendMappedText(parent, source.slice(cursor), mapping, cursor);
}

function markdown(
  source: RestrictedMarkdown | string,
  className?: string,
  textContext?: TextContextTarget,
): HTMLElement {
  const container = element("div", className === undefined ? "prose" : `prose ${className}`);
  if (textContext !== undefined) {
    container.id = textRangeDomId(textContext.targetId, textContext.field);
    container.dataset.textTargetId = textContext.targetId;
    container.dataset.textField = textContext.field;
    container.tabIndex = -1;
  }
  const normalized = normalizeMarkdownSource(source);
  let mappingCursor = 0;
  const nextMapping = (value: string): InlineSourceMap | undefined => {
    const start = normalized.value.indexOf(value, mappingCursor);
    if (start < 0) return undefined;
    mappingCursor = start + value.length;
    return { offsets: normalized.offsets, source, spans: [], start };
  };
  const lines = normalized.value.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence !== null) {
      const delimiter = fence[1] ?? "```";
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").match(
        new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}\\s*$`),
      )) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      const pre = element("pre", "prose-code");
      const code = element("code");
      const codeText = codeLines.join("\n");
      appendMappedText(code, codeText, nextMapping(codeText));
      pre.append(code);
      container.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading !== null) {
      const headingLevel = heading[1]?.length ?? 3;
      const headingElement = element(headingLevel === 1 ? "h2" : headingLevel === 2 ? "h3" : "h4");
      const headingText = heading[2] ?? "";
      appendInline(headingElement, headingText, nextMapping(headingText));
      container.append(headingElement);
      index += 1;
      continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d{1,9})[.)])\s+(.+)$/);
    if (list !== null) {
      const ordered = list[2] !== undefined;
      const listElement = element(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = (lines[index] ?? "").match(/^\s*(?:([-+*])|(\d{1,9})[.)])\s+(.+)$/);
        if (itemMatch === null || (itemMatch[2] !== undefined) !== ordered) break;
        const item = element("li");
        const itemText = itemMatch[3] ?? "";
        appendInline(item, itemText, nextMapping(itemText));
        listElement.append(item);
        index += 1;
      }
      container.append(listElement);
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote = element("blockquote");
      const quoteLines: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      for (const [quoteIndex, quoteLine] of quoteLines.entries()) {
        if (quoteIndex > 0) quote.append(document.createTextNode("\n"));
        appendInline(quote, quoteLine, nextMapping(quoteLine));
      }
      container.append(quote);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^(?: {0,3}(?:`{3,}|~{3,}|#{1,3}\s|>)|\s*(?:[-+*]|\d{1,9}[.)])\s)/.test(lines[index] ?? "")
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    const paragraph = element("p");
    const paragraphText = paragraphLines.join("\n");
    appendInline(paragraph, paragraphText, nextMapping(paragraphText));
    container.append(paragraph);
  }
  return container;
}

function inlineMarkdown(
  source: RestrictedMarkdown | string,
  className?: string,
  textContext?: TextContextTarget,
): HTMLElement {
  const container = element("span", className);
  if (textContext !== undefined) {
    container.id = textRangeDomId(textContext.targetId, textContext.field);
    container.dataset.textTargetId = textContext.targetId;
    container.dataset.textField = textContext.field;
  }
  const normalized = normalizeMarkdownSource(source);
  appendInline(container, normalized.value, {
    offsets: normalized.offsets,
    source,
    spans: [],
    start: 0,
  });
  return container;
}

function moduleName(type: ExplanationModule["type"]): string {
  return {
    story: "Story",
    systemFlow: "System flow",
    responsibility: "Responsibility",
    sourceExcerpt: "Source excerpt",
    requestSequence: "Request sequence",
    comparison: "Comparison",
    valueTrace: "Value trace",
    executionTrace: "Execution trace",
    callout: "Callout",
  }[type];
}

function moduleTitle(module: ExplanationModule): string {
  if (module.title !== undefined) return module.title;
  if (module.type === "callout") return `${module.tone.replace("-", " ")} note`;
  return moduleName(module.type);
}

interface SectionNavigationItem {
  readonly href: string;
  readonly id: string;
  readonly moduleType: string;
  readonly number: string;
  readonly title: string;
}

function sectionNavigationItems(sections: readonly ExplanationModule[]): readonly SectionNavigationItem[] {
  return sections.map((module, index) => ({
    href: `#${artifactDomId(module.id)}`,
    id: module.id,
    moduleType: moduleName(module.type),
    number: String(index + 1).padStart(2, "0"),
    title: inlineMarkdown(moduleTitle(module)).textContent.trim() || module.id,
  }));
}

function sectionNavigationLink(item: SectionNavigationItem): HTMLAnchorElement {
  const link = element("a", "step-link");
  link.href = item.href;
  link.dataset.sectionId = item.id;
  link.setAttribute("aria-label", `Step ${item.number}: ${item.title}`);
  link.append(
    element("span", "step-number", item.number),
    element("span", "step-title", item.title),
    element("small", "step-module-type", item.moduleType),
  );
  return link;
}

function sectionNavigationList(items: readonly SectionNavigationItem[]): HTMLOListElement {
  const list = element("ol");
  for (const item of items) {
    const listItem = element("li");
    listItem.append(sectionNavigationLink(item));
    list.append(listItem);
  }
  return list;
}

function stepNavigation(items: readonly SectionNavigationItem[]): HTMLElement {
  const navigation = element("nav", "step-navigation");
  navigation.setAttribute("aria-label", "Walkthrough steps");
  navigation.append(element("p", "contents-title", "In this walkthrough"), sectionNavigationList(items));
  return navigation;
}

function sectionOverview(items: readonly SectionNavigationItem[]): HTMLDetailsElement {
  const overview = element("details", "section-overview");
  overview.open = true;
  overview.setAttribute("aria-label", "In this walkthrough");
  const list = sectionNavigationList(items);
  list.style.setProperty("--overview-row-count", String(Math.ceil(items.length / 2)));
  list.classList.toggle("has-unpaired-step", items.length % 2 === 1);
  const summary = element("summary", "section-overview-summary");
  const summaryCopy = element("span", "section-overview-summary-copy");
  const initialItem = items[0];
  summaryCopy.append(
    element("span", "contents-title", "In this walkthrough"),
    element(
      "span",
      "section-overview-current",
      initialItem === undefined ? "" : `Current step ${initialItem.number}: ${initialItem.title}`,
    ),
  );
  summary.append(
    summaryCopy,
    element("span", "section-overview-count", `${items.length} steps`),
  );
  overview.append(summary, list);
  return overview;
}

let stopSectionNavigationTracking = (): void => undefined;

function trackActiveSection(
  items: readonly SectionNavigationItem[],
  navigation: HTMLElement,
  overview: HTMLDetailsElement,
): void {
  stopSectionNavigationTracking();
  const links = [...navigation.querySelectorAll<HTMLAnchorElement>("[data-section-id]"),
    ...overview.querySelectorAll<HTMLAnchorElement>("[data-section-id]")];
  const overviewCurrent = overview.querySelector<HTMLElement>(".section-overview-current");
  const sections = items.flatMap(({ id }) => {
    const section = document.getElementById(artifactDomId(id));
    return section === null ? [] : [{ id, section }];
  });
  let activeId = "";
  let frame: number | undefined;
  const paint = (): void => {
    frame = undefined;
    const threshold = Math.min(window.innerHeight * 0.4, 320) + 64;
    const visible = sections.filter(({ section }) => section.getBoundingClientRect().top <= threshold);
    const nextActiveId = visible.at(-1)?.id ?? sections[0]?.id ?? "";
    if (nextActiveId === activeId) return;
    activeId = nextActiveId;
    const activeItem = items.find((item) => item.id === activeId);
    if (overviewCurrent !== null && activeItem !== undefined) {
      overviewCurrent.textContent = `Current step ${activeItem.number}: ${activeItem.title}`;
    }
    for (const link of links) {
      const active = link.dataset.sectionId === activeId;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
    }
  };
  const schedulePaint = (): void => {
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(paint);
  };
  const wideNavigation = window.matchMedia("(min-width: 87.5rem)");
  const paintPresentation = (): void => {
    navigation.dataset.presentation = wideNavigation.matches ? "full" : "rail";
  };
  window.addEventListener("scroll", schedulePaint, { passive: true });
  window.addEventListener("resize", schedulePaint);
  wideNavigation.addEventListener("change", paintPresentation);
  paintPresentation();
  paint();
  stopSectionNavigationTracking = (): void => {
    window.removeEventListener("scroll", schedulePaint);
    window.removeEventListener("resize", schedulePaint);
    wideNavigation.removeEventListener("change", paintPresentation);
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
}

function evidenceReference(reference: SourceReference, label = "Source evidence"): HTMLElement {
  const wrapper = element("div", "source-reference");
  wrapper.append(element("span", "source-reference-label", label));
  const value = element("span", "source-reference-value");
  value.append(element("span", "source-reference-path", reference.file));
  const details: string[] = [];
  if (reference.symbol !== undefined) {
    value.append(
      element("span", "source-reference-detail source-reference-symbol", ` · ${reference.symbol}`),
    );
  }
  if (reference.line !== undefined) details.push(`line ${reference.line}`);
  if (reference.startLine !== undefined && reference.endLine !== undefined) {
    details.push(`lines ${reference.startLine}-${reference.endLine}`);
  }
  for (const detail of details) {
    value.append(element("span", "source-reference-detail", ` · ${detail}`));
  }
  wrapper.append(value);
  return wrapper;
}

function annotations(items: Annotation[] | undefined): HTMLElement | undefined {
  if (items === undefined || items.length === 0) return undefined;
  const aside = element("aside", "annotations");
  aside.setAttribute("aria-label", "Annotations");
  for (const annotation of items) {
    const item = element("div", "annotation");
    item.id = artifactDomId(annotation.id);
    item.dataset.annotationId = annotation.id;
    item.append(markdown(annotation.content, undefined, { targetId: annotation.id, field: "content" }));
    aside.append(item);
  }
  return aside;
}

function labeledText(
  label: string,
  value: RestrictedMarkdown | string,
  textContext?: TextContextTarget,
  labelContext?: TextContextTarget,
): HTMLElement {
  const card = element("div", "labeled-text");
  const heading = element("h3", "eyebrow");
  if (labelContext === undefined) {
    heading.textContent = label;
  } else {
    const normalizedLabel = normalizeMarkdownSource(label);
    heading.id = textRangeDomId(labelContext.targetId, labelContext.field);
    heading.dataset.textTargetId = labelContext.targetId;
    heading.dataset.textField = labelContext.field;
    heading.tabIndex = -1;
    appendMappedText(heading, normalizedLabel.value, {
      offsets: normalizedLabel.offsets,
      source: label,
      spans: [],
      start: 0,
    });
  }
  card.append(heading, markdown(value, undefined, textContext));
  return card;
}

function relationships(label: string, ids: readonly string[]): HTMLElement {
  const navigation = element("nav", "relationships");
  navigation.setAttribute("aria-label", label);
  navigation.append(element("span", "source-reference-label", label));
  const list = element("ul");
  for (const id of ids) {
    const item = element("li");
    const relatedItem = currentArtifact === undefined ? undefined : artifactItem(currentArtifact, id);
    const relatedModule = currentArtifact?.sections.find((module) => module.id === id);
    const candidate = relatedModule === undefined
      ? relatedItem?.label ?? relatedItem?.action ?? relatedItem?.content ?? relatedItem?.actor
      : moduleTitle(relatedModule);
    const displayLabel = typeof candidate === "string"
      ? inlineMarkdown(candidate).textContent.trim() || id
      : id;
    const link = element("a", undefined, displayLabel);
    link.href = `#${artifactDomId(id)}`;
    item.append(link);
    list.append(item);
  }
  navigation.append(list);
  return navigation;
}

function renderStory(module: Extract<ExplanationModule, { type: "story" }>): HTMLElement {
  const grid = element("div", "story-grid");
  grid.append(
    labeledText("Trigger", module.trigger, { targetId: module.id, field: "trigger" }),
    labeledText("Path", module.path, { targetId: module.id, field: "path" }),
    labeledText("Outcome", module.outcome, { targetId: module.id, field: "outcome" }),
    labeledText("Purpose", module.purpose, { targetId: module.id, field: "purpose" }),
  );
  return grid;
}

function renderSystemFlow(module: Extract<ExplanationModule, { type: "systemFlow" }>): HTMLElement {
  const list = element("ol", "flow-list");
  for (const [index, node] of module.nodes.entries()) {
    const item = element("li", "flow-node");
    item.id = artifactDomId(node.id);
    item.dataset.itemId = node.id;
    item.append(element("span", "flow-index", String(index + 1)));
    const body = element("div", "flow-body");
    body.append(
      markdown(node.label, "flow-title", { targetId: node.id, field: "label" }),
      markdown(node.responsibility, undefined, { targetId: node.id, field: "responsibility" }),
    );
    if (node.sourceEvidence !== undefined) body.append(evidenceReference(node.sourceEvidence));
    item.append(body);
    list.append(item);
  }
  return list;
}

function renderResponsibility(module: Extract<ExplanationModule, { type: "responsibility" }>): HTMLElement {
  const content = element("div", "responsibility-layout");
  content.append(labeledText("Owns", module.responsibility, {
    targetId: module.id,
    field: "responsibility",
  }));
  const groups = element("div", "responsibility-groups");
  for (const [label, values] of [
    ["Inputs", module.inputs],
    ["Outputs", module.outputs],
    ["Does not own", module.excludes],
  ] as const) {
    const group = element("div", "compact-list");
    group.append(element("h3", "eyebrow", label));
    const list = element("ul");
    for (const [index, value] of values.entries()) {
      const item = element("li");
      const field = label === "Inputs" ? `inputs.${index}` : label === "Outputs" ? `outputs.${index}` : `excludes.${index}`;
      item.append(markdown(value, undefined, { targetId: module.id, field }));
      list.append(item);
    }
    group.append(list);
    groups.append(group);
  }
  content.append(groups);
  if (module.calledBy.length > 0) content.append(relationships("Called by", module.calledBy));
  if (module.sourceEvidence !== undefined) content.append(evidenceReference(module.sourceEvidence));
  return content;
}

const syntaxPattern = /(\/\/.*$|\/\*[\s\S]*?\*\/|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(?:async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|function|if|import|in|interface|let|new|null|return|switch|throw|true|try|type|undefined|while)\b|\b\d+(?:\.\d+)?\b)/gm;

function highlightedCode(source: string, mapping?: InlineSourceMap): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of source.matchAll(syntaxPattern)) {
    const index = match.index;
    if (index > cursor) {
      appendMappedText(fragment, source.slice(cursor, index), mapping, cursor);
    }
    const token = match[0];
    const className = token.startsWith("//") || token.startsWith("/*")
      ? "syntax-comment"
      : /^["'`]/.test(token)
        ? "syntax-string"
        : /^\d/.test(token)
          ? "syntax-number"
          : "syntax-keyword";
    const tokenElement = element("span", className);
    appendMappedText(tokenElement, token, mapping, index);
    fragment.append(tokenElement);
    cursor = index + token.length;
  }
  if (cursor < source.length) appendMappedText(fragment, source.slice(cursor), mapping, cursor);
  return fragment;
}

function renderSourceExcerpt(module: Extract<ExplanationModule, { type: "sourceExcerpt" }>): HTMLElement {
  const evidence = module.sourceEvidence;
  const sourceCard = element("div", "source-card");
  const sourceHeader = element("div", "source-header");
  const sourceIdentity = element("div", "source-identity");
  sourceIdentity.append(element("strong", undefined, evidence.file));
  sourceIdentity.append(element("span", undefined, evidence.symbol));
  sourceHeader.append(sourceIdentity);
  sourceHeader.append(element("span", "language-label", evidence.language));
  sourceCard.append(sourceHeader);
  if (module.evidenceState !== undefined && module.evidenceState.status !== "current") {
    const state = module.evidenceState;
    const message = state.status === "changed"
      ? "Saved evidence changed in the current working file. The saved excerpt remains visible below."
      : state.status === "missing"
        ? "The source file is missing from the current working files. The saved excerpt remains visible below."
        : `Saved evidence moved to ${state.currentFile ?? "another file"}, lines ${state.currentStartLine ?? "?"}-${state.currentEndLine ?? "?"}.`;
    const warning = element("aside", `stale-evidence stale-${state.status}`);
    warning.setAttribute("role", "status");
    warning.append(
      element("strong", undefined, state.status === "relocated" ? "Evidence relocated" : "Stale evidence"),
      element("p", undefined, message),
    );
    sourceCard.append(warning);
  }

  const metadata = element("dl", "source-metadata");
  for (const [term, value] of [
    ["Lines", `${evidence.startLine}-${evidence.endLine}`],
    ["Evidence", module.evidenceLabel.replace("-", " ")],
    ["Excerpt hash", evidence.contentHash],
  ]) {
    metadata.append(element("dt", undefined, term), element("dd", undefined, value));
  }
  sourceCard.append(metadata);

  const pre = element("pre", "source-code");
  pre.setAttribute("aria-label", `${evidence.file}, lines ${evidence.startLine} through ${evidence.endLine}`);
  const code = element("code");
  code.id = textRangeDomId(module.id, "code");
  code.dataset.textTargetId = module.id;
  code.dataset.textField = "code";
  code.tabIndex = -1;
  const normalizedCode = normalizeMarkdownSource(module.code);
  let lineStart = 0;
  for (const [offset, line] of normalizedCode.value.split("\n").entries()) {
    const lineNumber = evidence.startLine + offset;
    const lineElement = element("span", "code-line");
    lineElement.id = lineDomId(module.id, lineNumber);
    lineElement.dataset.line = String(lineNumber);
    const matchingHighlights = module.highlights.filter(
      ({ startLine, endLine }) => lineNumber >= startLine && lineNumber <= endLine,
    );
    if (matchingHighlights.length > 0) {
      lineElement.classList.add("is-highlighted");
      lineElement.title = matchingHighlights.map(({ label }) => label).join(" · ");
    }
    const lineButton = element("button", "line-number", String(lineNumber));
    lineButton.type = "button";
    lineButton.id = `${lineDomId(module.id, lineNumber)}-selector`;
    lineButton.dataset.lineSelector = "true";
    lineButton.setAttribute("aria-label", `Select line ${lineNumber} of ${evidence.file}`);
    lineButton.setAttribute("aria-pressed", "false");
    lineButton.tabIndex = offset === 0 ? 0 : -1;
    const makeCurrentLineSelector = (): void => {
      for (const button of code.querySelectorAll<HTMLButtonElement>("[data-line-selector]")) {
        button.tabIndex = button === lineButton ? 0 : -1;
      }
    };
    lineButton.addEventListener("focus", makeCurrentLineSelector);
    const selectThrough = (endLine: number): void => {
      const anchor = lineSelectionAnchor?.targetId === module.id
        ? lineSelectionAnchor.line
        : lineNumber;
      if (lineSelectionAnchor?.targetId === module.id && lineSelectionAnchor.rangeKey !== undefined) {
        selectedSourceLineRanges.delete(lineSelectionAnchor.rangeKey);
      }
      const selectedRange = {
        targetId: module.id,
        file: evidence.file,
        startLine: Math.min(anchor, endLine),
        endLine: Math.max(anchor, endLine),
      };
      const rangeKey = sourceLineRangeKey(selectedRange);
      selectedSourceLineRanges.set(rangeKey, selectedRange);
      lineSelectionAnchor = { targetId: module.id, line: anchor, rangeKey };
      userSelectionChanged();
    };
    lineButton.addEventListener("click", (event) => {
      makeCurrentLineSelector();
      if (event.shiftKey && lineSelectionAnchor?.targetId === module.id) {
        selectThrough(lineNumber);
      } else if (selectedSourceLineRanges.delete(sourceLineRangeKey({
        targetId: module.id,
        file: evidence.file,
        startLine: lineNumber,
        endLine: lineNumber,
      }))) {
        if (lineSelectionAnchor?.targetId === module.id && lineSelectionAnchor.line === lineNumber) {
          lineSelectionAnchor = undefined;
        }
        userSelectionChanged();
      } else {
        lineSelectionAnchor = { targetId: module.id, line: lineNumber };
        selectThrough(lineNumber);
      }
    });
    lineButton.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (event.shiftKey && lineSelectionAnchor?.targetId !== module.id) {
        lineSelectionAnchor = { targetId: module.id, line: lineNumber };
      }
      const nextLine = Math.max(
        evidence.startLine,
        Math.min(evidence.endLine, lineNumber + (event.key === "ArrowUp" ? -1 : 1)),
      );
      const nextButton = document
        .getElementById(lineDomId(module.id, nextLine))
        ?.querySelector<HTMLButtonElement>("[data-line-selector]");
      if (nextButton === undefined || nextButton === null) return;
      if (event.shiftKey) selectThrough(nextLine);
      lineButton.tabIndex = -1;
      nextButton.tabIndex = 0;
      nextButton.focus();
    });
    lineElement.append(lineButton);
    const lineCode = element("span", "line-code");
    lineCode.append(highlightedCode(line, {
      offsets: normalizedCode.offsets,
      source: module.code,
      spans: [],
      start: lineStart,
    }));
    lineElement.append(lineCode);
    code.append(lineElement);
    lineStart += line.length + 1;
  }
  pre.append(code);
  sourceCard.append(pre);

  const highlights = element("ul", "highlight-list");
  for (const highlight of module.highlights) {
    const item = element("li");
    item.id = artifactDomId(highlight.id);
    item.dataset.itemId = highlight.id;
    const link = element("a");
    link.href = `#${lineDomId(module.id, highlight.startLine)}`;
    link.textContent = `${highlight.startLine === highlight.endLine ? `Line ${highlight.startLine}` : `Lines ${highlight.startLine}-${highlight.endLine}`}: `;
    const label = markdown(highlight.label, "highlight-label", { targetId: highlight.id, field: "label" });
    link.append(label);
    item.append(link);
    highlights.append(item);
  }
  sourceCard.append(highlights);
  sourceCard.append(relationships("Related modules", module.relatedIds));

  const explanation = element("div", "excerpt-explanation");
  explanation.append(
    labeledText("What happens", module.explanation, { targetId: module.id, field: "explanation" }),
    labeledText("Input", module.inputs, { targetId: module.id, field: "inputs" }),
    labeledText("Output", module.output, { targetId: module.id, field: "output" }),
    labeledText("Why this excerpt", module.selectionReason, { targetId: module.id, field: "selectionReason" }),
  );
  const wrapper = element("div", "excerpt-layout");
  wrapper.append(sourceCard, explanation);
  return wrapper;
}

function renderSequence(module: Extract<ExplanationModule, { type: "requestSequence" }>): HTMLElement {
  const list = element("ol", "sequence-list");
  for (const [index, step] of module.steps.entries()) {
    const item = element("li", "sequence-step");
    item.id = artifactDomId(step.id);
    item.dataset.itemId = step.id;
    item.append(element("span", "sequence-index", String(index + 1)));
    const body = element("div");
    body.append(
      markdown(step.actor, "sequence-actor", { targetId: step.id, field: "actor" }),
      markdown(step.action, undefined, { targetId: step.id, field: "action" }),
    );
    const result = labeledText("Result", step.result, { targetId: step.id, field: "result" });
    result.classList.add("sequence-result");
    body.append(result);
    if (step.sourceEvidence !== undefined) body.append(evidenceReference(step.sourceEvidence));
    item.append(body);
    list.append(item);
  }
  return list;
}

function renderComparison(module: Extract<ExplanationModule, { type: "comparison" }>): HTMLElement {
  const wrapper = element("div");
  const grid = element("div", "comparison-grid");
  grid.append(
    labeledText(
      module.leftLabel,
      module.left,
      { targetId: module.id, field: "left" },
      { targetId: module.id, field: "leftLabel" },
    ),
    labeledText(
      module.rightLabel,
      module.right,
      { targetId: module.id, field: "right" },
      { targetId: module.id, field: "rightLabel" },
    ),
  );
  wrapper.append(grid);
  if (module.conclusion !== undefined) {
    wrapper.append(labeledText("Conclusion", module.conclusion, {
      targetId: module.id,
      field: "conclusion",
    }));
  }
  return wrapper;
}

function renderValueTrace(module: Extract<ExplanationModule, { type: "valueTrace" }>): HTMLElement {
  const list = element("ol", "trace-list");
  for (const step of module.steps) {
    const item = element("li", "trace-step");
    item.id = artifactDomId(step.id);
    item.dataset.itemId = step.id;
    item.append(
      markdown(step.label, "trace-label", { targetId: step.id, field: "label" }),
      markdown(step.value, "trace-value", { targetId: step.id, field: "value" }),
    );
    if (step.sourceEvidence !== undefined) item.append(evidenceReference(step.sourceEvidence));
    list.append(item);
  }
  return list;
}

function renderExecutionTrace(
  module: Extract<ExplanationModule, { type: "executionTrace" }>,
): HTMLElement {
  const wrapper = element("div", "execution-trace");
  wrapper.append(markdown(module.summary, "trace-summary", {
    targetId: module.id,
    field: "summary",
  }));
  const list = element("ol", "execution-trace-list");
  for (const [index, step] of module.steps.entries()) {
    const item = element("li", "execution-trace-step");
    item.id = artifactDomId(step.id);
    item.dataset.itemId = step.id;
    const disclosure = element("details", "trace-disclosure");
    disclosure.open = index === 0;
    const summary = element("summary");
    const summaryContent = element("span", "trace-summary-content");
    summaryContent.append(
      element("span", "sequence-index", String(index + 1)),
      inlineMarkdown(step.label, "trace-label", { targetId: step.id, field: "label" }),
      element(
        "span",
        `evidence-badge evidence-${step.evidenceLabel}`,
        step.evidenceLabel.replace("-", " "),
      ),
    );
    summary.append(summaryContent);
    const body = element("div", "trace-detail");
    body.append(markdown(step.action, undefined, { targetId: step.id, field: "action" }));
    if (step.valueBefore !== undefined && step.valueAfter !== undefined) {
      const values = element("dl", "trace-values");
      const before = element("dd");
      before.append(markdown(step.valueBefore, undefined, {
        targetId: step.id,
        field: "valueBefore",
      }));
      const after = element("dd");
      after.append(markdown(step.valueAfter, undefined, {
        targetId: step.id,
        field: "valueAfter",
      }));
      values.append(
        element("dt", undefined, "Before"),
        before,
        element("dt", undefined, "After"),
        after,
      );
      body.append(values);
    }
    if (step.branch !== undefined) {
      body.append(labeledText("Branch", step.branch, { targetId: step.id, field: "branch" }));
    }
    if (step.detail !== undefined) {
      body.append(labeledText("Detail", step.detail, { targetId: step.id, field: "detail" }));
    }
    if (step.sourceEvidence !== undefined) {
      body.append(evidenceReference(step.sourceEvidence, "Step evidence"));
    }
    disclosure.append(summary, body);
    item.append(disclosure);
    list.append(item);
  }
  wrapper.append(list);
  return wrapper;
}

function renderCallout(module: Extract<ExplanationModule, { type: "callout" }>): HTMLElement {
  const callout = element("aside", `callout callout-${module.tone}`);
  callout.append(
    element("span", "callout-mark", "!"),
    markdown(module.content, undefined, { targetId: module.id, field: "content" }),
  );
  if (module.sourceEvidence !== undefined) callout.append(evidenceReference(module.sourceEvidence));
  return callout;
}

function moduleContent(module: ExplanationModule): HTMLElement {
  switch (module.type) {
    case "story": return renderStory(module);
    case "systemFlow": return renderSystemFlow(module);
    case "responsibility": return renderResponsibility(module);
    case "sourceExcerpt": return renderSourceExcerpt(module);
    case "requestSequence": return renderSequence(module);
    case "comparison": return renderComparison(module);
    case "valueTrace": return renderValueTrace(module);
    case "executionTrace": return renderExecutionTrace(module);
    case "callout": return renderCallout(module);
  }
}

function renderModule(module: ExplanationModule, index: number): HTMLElement {
  const article = element("article", `module module-${module.type}`);
  article.id = artifactDomId(module.id);
  article.dataset.moduleId = module.id;
  article.dataset.moduleType = module.type;
  article.tabIndex = -1;
  const header = element("header", "module-header");
  const headingGroup = element("div");
  headingGroup.append(element("p", "module-kicker", `${String(index + 1).padStart(2, "0")} · ${moduleName(module.type)}`));
  const heading = element("h2");
  heading.id = headingDomId(module.id);
  heading.append(markdown(
    moduleTitle(module),
    "heading-markdown",
    module.title === undefined ? undefined : { targetId: module.id, field: "title" },
  ));
  headingGroup.append(heading);
  header.append(headingGroup);
  const selectionButton = element("button", "context-toggle", "Select section");
  selectionButton.type = "button";
  selectionButton.id = `${artifactDomId(module.id)}-selector`;
  selectionButton.dataset.moduleSelector = module.id;
  selectionButton.setAttribute("aria-pressed", "false");
  selectionButton.setAttribute("aria-label", `Select ${moduleTitle(module)} as question context`);
  selectionButton.addEventListener("click", () => {
    if (selectedModules.has(module.id)) selectedModules.delete(module.id);
    else selectedModules.add(module.id);
    userSelectionChanged();
  });
  header.append(selectionButton);
  if (module.type === "sourceExcerpt") {
    header.append(element("span", `evidence-badge evidence-${module.evidenceLabel}`, module.evidenceLabel.replace("-", " ")));
    if (module.evidenceState !== undefined) {
      header.append(element(
        "span",
        `evidence-state evidence-state-${module.evidenceState.status}`,
        module.evidenceState.status,
      ));
      article.classList.toggle("is-stale", module.evidenceState.status !== "current");
    }
  }
  article.setAttribute("aria-labelledby", heading.id);
  article.append(header, moduleContent(module));
  const moduleAnnotations = annotations(module.annotations);
  if (moduleAnnotations !== undefined) article.append(moduleAnnotations);
  return article;
}

function newStableId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function timestampAfter(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init.headers },
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new HttpRequestError(
      result.error ?? `The local runtime returned ${response.status}.`,
      response.status,
    );
  }
  return result;
}

function isDefinitiveRequestFailure(error: unknown): boolean {
  return error instanceof HttpRequestError && error.status >= 400 && error.status < 500;
}

function textRangeKey(selection: TextRangeSelection): string {
  return `${selection.targetId}\u0000${selection.field}\u0000${selection.startOffset}\u0000${selection.endOffset}`;
}

function sourceLineRangeKey(selection: SourceLineSelection): string {
  return `${selection.targetId}\u0000${selection.file}\u0000${selection.startLine}\u0000${selection.endLine}`;
}

function contextChipDomId(selection: ContextSelectionItem): string {
  if (selection.kind === "module") {
    return viewerDomId(`context-chip-module-${selection.targetId}`);
  }
  const key = selection.kind === "textRange"
    ? textRangeKey(selection)
    : sourceLineRangeKey(selection);
  return viewerDomId(`context-chip-${selection.kind}-${encodeURIComponent(key)}`);
}

interface MappedBoundary {
  readonly offset: number;
  readonly source: string;
  readonly spans: readonly InlineSourceSpan[];
}

function firstMappedBoundary(node: Node): MappedBoundary | undefined {
  if (node instanceof Text) {
    const mapping = textNodeSourceMaps.get(node);
    const offset = mapping?.offsets[0];
    return mapping === undefined || offset === undefined ? undefined : {
      source: mapping.source,
      offset,
      spans: mapping.spans,
    };
  }
  for (const child of node.childNodes) {
    const boundary = firstMappedBoundary(child);
    if (boundary !== undefined) return boundary;
  }
  return undefined;
}

function lastMappedBoundary(node: Node): MappedBoundary | undefined {
  if (node instanceof Text) {
    const mapping = textNodeSourceMaps.get(node);
    const offset = mapping?.offsets[node.data.length];
    return mapping === undefined || offset === undefined ? undefined : {
      source: mapping.source,
      offset,
      spans: mapping.spans,
    };
  }
  for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
    const child = node.childNodes.item(index);
    const boundary = lastMappedBoundary(child);
    if (boundary !== undefined) return boundary;
  }
  return undefined;
}

function mappedBoundary(node: Node, offset: number, end: boolean): MappedBoundary | undefined {
  if (node instanceof Text) {
    const mapping = textNodeSourceMaps.get(node);
    const mappedOffset = mapping?.offsets[offset];
    if (mapping === undefined || mappedOffset === undefined) return undefined;
    return {
      source: mapping.source,
      offset: mappedOffset,
      spans: mapping.spans,
    };
  }
  if (end) {
    const child = offset > 0 ? node.childNodes.item(offset - 1) : undefined;
    return child === undefined ? undefined : lastMappedBoundary(child);
  }
  const child = offset < node.childNodes.length ? node.childNodes.item(offset) : undefined;
  return child === undefined ? undefined : firstMappedBoundary(child);
}

function textContextElement(node: Node): HTMLElement | undefined {
  const elementNode = node instanceof HTMLElement ? node : node.parentElement;
  return elementNode?.closest<HTMLElement>("[data-text-target-id][data-text-field]") ?? undefined;
}

function selectedTextRange(): TextRangeSelection | undefined {
  if (!contextSelectionAvailable) return;
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const startTarget = textContextElement(range.startContainer);
  const endTarget = textContextElement(range.endContainer);
  if (startTarget === undefined || startTarget !== endTarget) return;
  const targetId = startTarget.dataset.textTargetId;
  const field = startTarget.dataset.textField;
  if (targetId === undefined || field === undefined) return;
  const start = mappedBoundary(range.startContainer, range.startOffset, false);
  const end = mappedBoundary(range.endContainer, range.endOffset, true);
  if (start === undefined || end === undefined || start.source !== end.source) return;
  const startOffset = start.spans
    .filter((span) => !end.spans.includes(span))
    .reduce((offset, span) => Math.min(offset, span.startOffset), start.offset);
  const endOffset = end.spans
    .filter((span) => !start.spans.includes(span))
    .reduce((offset, span) => Math.max(offset, span.endOffset), end.offset);
  if (endOffset <= startOffset) return;
  const selectedText = Array.from(start.source).slice(startOffset, endOffset).join("");
  if (selectedText.trim().length === 0) return;
  const selectedRange: TextRangeSelection = {
    kind: "textRange",
    targetId: targetId as TextRangeSelection["targetId"],
    field,
    startOffset,
    endOffset,
    selectedText,
  };
  return selectedRange;
}

function captureTextSelection(): void {
  const selectedRange = selectedTextRange();
  if (selectedRange === undefined) return;
  const rangeKey = textRangeKey(selectedRange);
  if (selectedTextRanges.get(rangeKey)?.selectedText === selectedRange.selectedText) return;
  selectedTextRanges.set(rangeKey, selectedRange);
  userSelectionChanged();
}

let textSelectionCaptureQueued = false;
let textSelectionGesture: "keyboard" | "pointer" | undefined;

function queueTextSelectionCapture(): void {
  if (textSelectionCaptureQueued) return;
  textSelectionCaptureQueued = true;
  window.setTimeout(() => {
    textSelectionCaptureQueued = false;
    captureTextSelection();
  }, 0);
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const target = event.target;
  const targetElement = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (targetElement !== null && targetElement.closest(".context-chip") !== null) {
    textSelectionGesture = undefined;
    return;
  }
  textSelectionGesture = "pointer";
});

document.addEventListener("pointerup", () => {
  if (textSelectionGesture !== "pointer") return;
  textSelectionGesture = undefined;
  queueTextSelectionCapture();
});

document.addEventListener("pointercancel", () => {
  if (textSelectionGesture === "pointer") textSelectionGesture = undefined;
});

const keyboardSelectionKeys = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

document.addEventListener("keydown", (event) => {
  if (event.shiftKey && keyboardSelectionKeys.has(event.key)) textSelectionGesture = "keyboard";
});

document.addEventListener("keyup", (event) => {
  if (textSelectionGesture !== "keyboard") return;
  if (event.key !== "Shift" && event.shiftKey) return;
  textSelectionGesture = undefined;
  queueTextSelectionCapture();
});

window.addEventListener("blur", () => {
  if (textSelectionGesture === undefined) return;
  textSelectionGesture = undefined;
  queueTextSelectionCapture();
});

document.addEventListener("selectionchange", () => {
  if (window.getSelection()?.isCollapsed !== false) return;
  if (textSelectionGesture === undefined) queueTextSelectionCapture();
});

function selectedContext(): ContextSelectionItem[] {
  const context: ContextSelectionItem[] = [...selectedModules].map((targetId) => ({
    kind: "module",
    targetId: targetId as ContextSelectionItem["targetId"],
  }));
  context.push(...selectedTextRanges.values());
  for (const selectedSourceLines of selectedSourceLineRanges.values()) {
    context.push({
      kind: "sourceLines",
      targetId: selectedSourceLines.targetId as ContextSelectionItem["targetId"],
      file: selectedSourceLines.file,
      startLine: selectedSourceLines.startLine,
      endLine: selectedSourceLines.endLine,
    });
  }
  return context;
}

function restoreContext(context: readonly ContextSelectionItem[] | null): void {
  selectedModules.clear();
  selectedTextRanges.clear();
  selectedSourceLineRanges.clear();
  lineSelectionAnchor = undefined;
  for (const item of context ?? []) {
    if (item.kind === "module") selectedModules.add(item.targetId);
    if (item.kind === "textRange") {
      selectedTextRanges.set(textRangeKey(item), item);
    }
    if (item.kind === "sourceLines") {
      const selectedRange: SourceLineSelection = item;
      const rangeKey = sourceLineRangeKey(selectedRange);
      selectedSourceLineRanges.set(rangeKey, selectedRange);
      lineSelectionAnchor = { targetId: item.targetId, line: item.startLine, rangeKey };
    }
  }
  selectionChanged();
}

function selectionLabel(item: ContextSelectionItem, artifact: WalkthroughArtifact): string {
  if (item.kind === "module") {
    const selectedModule = artifact.sections.find(({ id }) => id === item.targetId);
    return selectedModule === undefined ? item.targetId : moduleTitle(selectedModule);
  }
  if (item.kind === "sourceLines") {
    const lines = item.startLine === item.endLine
      ? `line ${item.startLine}`
      : `lines ${item.startLine}-${item.endLine}`;
    return `${item.file}, ${lines}`;
  }
  const targetModule = artifact.sections.find(({ id }) => id === item.targetId);
  const targetLabel = targetModule === undefined ? item.targetId : moduleTitle(targetModule);
  const collapsedText = item.selectedText.replaceAll(/\s+/g, " ");
  const preview = collapsedText.length > 54 ? `${collapsedText.slice(0, 51)}...` : collapsedText;
  return `"${preview}" from ${targetLabel}`;
}

function contextHref(item: ContextSelectionItem): string {
  if (item.kind === "module") return `#${artifactDomId(item.targetId)}`;
  if (item.kind === "sourceLines") return `#${lineDomId(item.targetId, item.startLine)}`;
  return `#${linkedTextRangeDomId(item)}`;
}

function cloneTextNodeMapping(
  mapping: TextNodeSourceMap,
  start: number,
  end: number,
): TextNodeSourceMap {
  return {
    offsets: mapping.offsets.slice(start, end + 1),
    source: mapping.source,
    spans: mapping.spans,
  };
}

function clearLinkedTextRange(): void {
  for (const mark of document.querySelectorAll<HTMLElement>("mark[data-linked-text-context]")) {
    mark.replaceWith(...mark.childNodes);
  }
}

function mappedRangeWithinNode(
  node: Text,
  selection: TextRangeSelection,
  source: string,
): { readonly end: number; readonly start: number } | undefined {
  const mapping = textNodeSourceMaps.get(node);
  if (mapping === undefined || mapping.source !== source) return;
  let start = mapping.offsets.findIndex((offset) => offset >= selection.startOffset);
  while (
    start >= 0 &&
    mapping.offsets[start + 1] === mapping.offsets[start]
  ) start += 1;
  let end = -1;
  for (let index = mapping.offsets.length - 1; index >= 0; index -= 1) {
    if ((mapping.offsets[index] ?? Number.POSITIVE_INFINITY) <= selection.endOffset) {
      end = index;
      break;
    }
  }
  if (start < 0 || end <= start) return;
  return { start, end };
}

function projectLinkedTextRange(
  selection: TextRangeSelection,
  contextId = linkedTextRangeDomId(selection),
): HTMLElement | undefined {
  clearLinkedTextRange();
  if (currentArtifact === undefined || !selectionIsValid(selection, currentArtifact)) return;
  const source = artifactText(currentArtifact, selection.targetId, selection.field);
  if (source === undefined) return;
  const target = document.getElementById(textRangeDomId(selection.targetId, selection.field));
  if (target === null) return;
  const segments: Array<{
    readonly end: number;
    readonly node: Text;
    readonly start: number;
  }> = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current !== null) {
    if (current instanceof Text) {
      const mapped = mappedRangeWithinNode(current, selection, source);
      if (mapped !== undefined) segments.push({ node: current, ...mapped });
    }
    current = walker.nextNode();
  }
  let firstMark: HTMLElement | undefined;
  for (const { end, node, start } of segments) {
    const mapping = textNodeSourceMaps.get(node);
    if (mapping === undefined) continue;
    const fragment = document.createDocumentFragment();
    if (start > 0) {
      const before = document.createTextNode(node.data.slice(0, start));
      textNodeSourceMaps.set(before, cloneTextNodeMapping(mapping, 0, start));
      fragment.append(before);
    }
    const markedText = document.createTextNode(node.data.slice(start, end));
    textNodeSourceMaps.set(markedText, cloneTextNodeMapping(mapping, start, end));
    const mark = element("mark", "linked-text-context");
    mark.dataset.linkedTextContext = contextId;
    mark.title = "Exact context sent with this question";
    mark.append(markedText);
    if (firstMark === undefined) {
      firstMark = mark;
      mark.id = contextId;
      mark.tabIndex = -1;
    }
    fragment.append(mark);
    if (end < node.data.length) {
      const after = document.createTextNode(node.data.slice(end));
      textNodeSourceMaps.set(after, cloneTextNodeMapping(mapping, end, node.data.length));
      fragment.append(after);
    }
    node.replaceWith(fragment);
  }
  return firstMark;
}

function revealLinkedTextRange(target: HTMLElement | undefined): void {
  for (
    let ancestor = target?.parentElement;
    ancestor !== null && ancestor !== undefined;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) ancestor.open = true;
  }
  target?.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  target?.focus({ preventScroll: true });
}

function restoreLinkedTextRangeFromHash(): void {
  let contextId: string;
  try {
    contextId = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    clearLinkedTextRange();
    return;
  }
  const selection = linkedTextRanges.get(contextId);
  if (selection === undefined) {
    clearLinkedTextRange();
    return;
  }
  revealLinkedTextRange(projectLinkedTextRange(selection, contextId));
}

function navigateToLinkedTextRange(selection: TextRangeSelection): void {
  const href = contextHref(selection);
  window.history.pushState(null, "", href);
  revealLinkedTextRange(projectLinkedTextRange(selection));
}

function contextReferenceLink(
  item: ContextSelectionItem,
  artifact: WalkthroughArtifact,
): HTMLAnchorElement {
  const link = element("a", undefined, selectionLabel(item, artifact));
  link.href = contextHref(item);
  if (item.kind === "textRange") {
    link.addEventListener("click", (event) => {
      if (
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
      ) return;
      event.preventDefault();
      navigateToLinkedTextRange(item);
    });
  }
  return link;
}

window.addEventListener("hashchange", restoreLinkedTextRangeFromHash);

function replyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (typeof content === "object" && content !== null && "content" in content) {
    const answer = (content as { content?: unknown }).content;
    if (typeof answer === "string") return answer;
  }
  if (typeof content === "object" && content !== null && "message" in content) {
    const message = (content as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(content);
}

function replyWalkthroughUpdate(content: unknown): { readonly expectedRevision: number; readonly id: string } | undefined {
  if (typeof content !== "object" || content === null || !("walkthroughUpdate" in content)) return;
  const update = (content as { walkthroughUpdate?: unknown }).walkthroughUpdate;
  if (
    typeof update !== "object" || update === null ||
    !("id" in update) || typeof update.id !== "string" ||
    !("expectedRevision" in update) || typeof update.expectedRevision !== "number"
  ) return;
  return { expectedRevision: update.expectedRevision, id: update.id };
}

function questionState(
  question: QuestionView,
  statuses: readonly StatusView[],
): "queued" | "investigating" | "reconnecting" | "answered" | "failed" | "cancelled" {
  if (question.state === "answered") return "answered";
  if (question.state === "failed") return "failed";
  if (question.state === "cancelled") return "cancelled";
  const latestStatus = statuses.findLast(({ questionId }) => questionId === question.id)?.status;
  if (latestStatus === "reconnecting") return "reconnecting";
  if (question.state === "acknowledged" || latestStatus === "investigating") return "investigating";
  return "queued";
}

function walkthroughGuidance(): HTMLDetailsElement {
  const guidance = element("details", "walkthrough-guidance");
  guidance.open = true;
  const summary = element("summary", "walkthrough-guidance-summary");
  summary.append(
    element("span", "walkthrough-guidance-icon", "?"),
    element("span", undefined, "How to use this walkthrough"),
  );
  const body = element("div", "walkthrough-guidance-body");
  body.append(
    element("p", undefined, "Use the In this walkthrough navigation to move between sections."),
    element(
      "p",
      undefined,
      "Select multiple passages, code ranges, source lines, or whole sections and combine them as context for one question.",
    ),
    element(
      "p",
      undefined,
      "You can privately queue several questions, each with its own context. Add to queue keeps each question and its context private. Only Send to agent contacts the agent and sends every queued question plus your current question.",
    ),
  );
  guidance.append(summary, body);
  return guidance;
}

function conversationStudio(): ConversationStudioView {
  const modeControls = element("div", "conversation-mode-controls");
  const modeCopy = element("div");
  const modeDescription = element(
    "p",
    "conversation-mode-description",
    "Analyze gives direct source-backed answers.",
  );
  modeCopy.append(
    element("p", "module-kicker", "Conversation mode"),
    modeDescription,
  );
  const modeButtons = element("div", "conversation-mode-buttons");
  modeButtons.setAttribute("role", "group");
  modeButtons.setAttribute("aria-label", "Conversation mode");
  const analyzeMode = element("button", "conversation-mode-button", "Analyze");
  analyzeMode.type = "button";
  const learnMode = element("button", "conversation-mode-button", "Learn");
  learnMode.type = "button";
  modeButtons.append(analyzeMode, learnMode);
  const modeOutcome = element("p", "conversation-mode-outcome");
  modeOutcome.setAttribute("role", "status");
  modeControls.append(modeCopy, modeButtons, modeOutcome);

  const learningControls = element("section", "learning-controls");
  const learningHeading = element("h2", "learning-heading", "What would help next?");
  learningHeading.id = viewerDomId("learning-heading");
  learningControls.setAttribute("aria-labelledby", learningHeading.id);
  learningControls.append(
    element("p", "module-kicker", "Learn with this walkthrough"),
    learningHeading,
    element(
      "p", "learning-description",
      "Choose one goal for the selected context, or type any question below.",
    ),
  );
  const learningGoals = element("div", "learning-choice-grid");
  learningGoals.setAttribute("role", "group");
  learningGoals.setAttribute("aria-label", "Learning goals");
  const simpler = element("button", "learning-goal");
  simpler.type = "button";
  simpler.dataset.learningIntent = "simpler";
  simpler.append(
    element("strong", "learning-goal-title", "Make it clearer"),
    element("span", "learning-goal-copy", "Explain the selected evidence more simply."),
  );
  const deeper = element("button", "learning-goal");
  deeper.type = "button";
  deeper.dataset.learningIntent = "deeper";
  deeper.append(
    element("strong", "learning-goal-title", "Build the mental model"),
    element("span", "learning-goal-copy", "Go deeper with source-backed connections."),
  );
  const checkMenu = element("details", "understanding-menu learning-goal-check");
  const checkSummary = element("summary", "learning-goal");
  checkSummary.append(
    element("strong", "learning-goal-title", "Check my understanding"),
    element("span", "learning-goal-copy", "Choose one focused, unscored check."),
  );
  const checkChoices = element("div", "understanding-choices");
  const checkPrompts = [
    ["multiple-choice", "Ask me one focused multiple-choice question about the selected context."],
    ["ordering", "Ask me to put the selected behavior's source-backed steps in execution order."],
    ["teach-back", "Let me explain the selected context back to you. Prompt me without scoring my response."],
    ["debugging", "Give me a small debugging scenario tied to the selected source evidence."],
    ["prediction", "Show me a focused snippet from this walkthrough and ask me to predict what it does."],
  ] as const;
  const checkButtons = checkPrompts.map(([intent, prompt]) => {
    const button = element("button", "understanding-choice", {
      "multiple-choice": "Focused multiple choice",
      ordering: "Order the steps",
      "teach-back": "Let me explain it back",
      debugging: "Give me a debugging scenario",
      prediction: "Ask me to predict a snippet",
    }[intent]);
    button.type = "button";
    button.dataset.learningIntent = intent;
    button.dataset.prompt = prompt;
    checkChoices.append(button);
    return button;
  });
  checkMenu.append(checkSummary, checkChoices);
  const learningOutcome = element("p", "learning-outcome");
  learningOutcome.setAttribute("role", "status");
  learningGoals.append(simpler, deeper, checkMenu);
  learningControls.append(learningGoals, learningOutcome);
  const composer = element("form", "question-composer");
  const composerHeading = element("h2", undefined, "Ask a follow-up");
  const composerHint = element(
    "p",
    "composer-hint",
    "Select context, add private drafts to the queue, or send now with Cmd/Ctrl+Enter.",
  );
  const contextHeading = element("p", "context-heading", "Selected context");
  const contextSummary = element("div", "context-summary");
  contextSummary.setAttribute("aria-live", "polite");
  const label = element("label", "question-label", "Your question");
  label.htmlFor = viewerDomId("question-message");
  const textarea = element("textarea", "question-message");
  textarea.id = viewerDomId("question-message");
  textarea.name = "message";
  textarea.rows = 3;
  textarea.required = true;
  textarea.placeholder = "What would you like the agent to explain?";
  const actions = element("div", "composer-actions");
  const submit = element("button", "submit-question", "Add to queue");
  submit.type = "submit";
  submit.id = viewerDomId("submit-question");
  const sendToAgent = element("button", "send-questions", "Send to agent");
  sendToAgent.type = "button";
  sendToAgent.id = viewerDomId("send-questions");
  const discardEdit = element("button", "cancel-edit", "Discard edit");
  discardEdit.type = "button";
  discardEdit.id = viewerDomId("discard-edit");
  discardEdit.hidden = true;
  const outcome = element("p", "composer-outcome");
  outcome.setAttribute("role", "status");
  outcome.setAttribute("aria-label", "Composer status");
  actions.append(submit, sendToAgent, discardEdit, outcome);
  composer.append(
    modeControls,
    learningControls,
    composerHeading,
    composerHint,
    contextHeading,
    contextSummary,
    label,
    textarea,
    actions,
  );

  const conversation = element("section", "conversation-panel");
  conversation.setAttribute("aria-label", "Ask about this walkthrough");
  conversation.tabIndex = -1;
  const conversationHeader = element("div", "conversation-header");
  conversationHeader.id = viewerDomId("conversation-summary");
  const agentStatus = element("span", "agent-status", "Waiting");
  agentStatus.setAttribute("role", "status");
  agentStatus.setAttribute("aria-label", "Agent status");
  agentStatus.dataset.state = "waiting";
  const conversationCount = element("span", "conversation-count", "0 questions");
  const conversationToggle = element("button", "conversation-toggle", "Open");
  conversationToggle.type = "button";
  conversationToggle.id = viewerDomId("conversation-toggle");
  conversationToggle.setAttribute("aria-expanded", "false");
  conversationToggle.setAttribute("aria-controls", viewerDomId("conversation-body"));
  conversationToggle.setAttribute("aria-label", "Open Conversation");
  const compactConversation = window.matchMedia("(max-width: 52rem)");
  let compactToggleHadFocus = false;
  conversationToggle.addEventListener("focus", () => {
    compactToggleHadFocus = true;
  });
  conversationToggle.addEventListener("blur", () => {
    if (compactConversation.matches) compactToggleHadFocus = false;
  });
  const setConversationOpen = (open: boolean): void => {
    conversation.classList.toggle("is-open", open);
    conversationToggle.textContent = open ? "Close" : "Open";
    conversationToggle.setAttribute("aria-expanded", String(open));
    conversationToggle.setAttribute(
      "aria-label",
      `${open ? "Close" : "Open"} Conversation`,
    );
  };
  conversationToggle.addEventListener("click", () => {
    const open = !conversation.classList.contains("is-open");
    if (!open) conversationToggle.focus({ preventScroll: true });
    setConversationOpen(open);
  });
  conversationHeader.append(
    element("span", undefined, "Conversation"),
    agentStatus,
    conversationCount,
    conversationToggle,
  );
  const conversationList = element("ol", "conversation-list");
  const emptyConversation = element("p", "empty-conversation", "Queued questions and completed answers will appear here.");
  const draftQueue = element("section", "draft-queue");
  draftQueue.setAttribute("aria-label", "Draft queue");
  draftQueue.hidden = true;
  const draftQueueHeader = element("div", "draft-queue-header");
  const draftCount = element("span", "draft-count", "0 drafts");
  draftQueueHeader.append(element("h2", undefined, "Draft queue"), draftCount);
  const draftList = element("ol", "draft-list");
  draftQueue.append(draftQueueHeader, draftList);
  const conversationBody = element("div", "conversation-body");
  conversationBody.id = viewerDomId("conversation-body");
  conversationBody.append(composer, draftQueue, emptyConversation, conversationList);
  conversation.append(conversationHeader, conversationBody);
  const synchronizeResponsiveDisclosure = (): void => {
    if (compactConversation.matches && conversationBody.contains(document.activeElement)) {
      setConversationOpen(true);
    } else if (!compactConversation.matches && compactToggleHadFocus) {
      compactToggleHadFocus = false;
      (textarea.disabled ? conversation : textarea).focus({ preventScroll: true });
    }
  };
  conversationBody.addEventListener("focusin", synchronizeResponsiveDisclosure);
  compactConversation.addEventListener("change", synchronizeResponsiveDisclosure);

  let session: SessionView | undefined;
  let conversationMode: ConversationMode = "analyze";
  let modeGeneration = 0;
  let modeKnownThroughSequence = 0;
  let sessionKnownThroughSequence = 0;
  let modeSaveGeneration = 0;
  let editingQuestionId: string | undefined;
  let editingDraftId: string | undefined;
  let editingDraftMode: ConversationMode | undefined;
  let editingDraftBaseline: {
    readonly artifactRevision: number;
    readonly context: readonly ContextSelectionItem[];
    readonly selectionGeneration: number;
    readonly updatedAt: string;
  } | undefined;
  let modeRecoveryPending = false;
  let modeRecoveryRequest: Promise<boolean> | undefined;
  let modeRecoveryTimer: number | undefined;
  let modeRequestInFlight = false;
  let requestInFlight = false;
  const selectedComposerMode = (): ConversationMode => editingDraftMode ?? conversationMode;
  const conversationModeNeedsRecovery = (): boolean => modeRecoveryPending;
  let pendingSubmission: {
    readonly body: object;
    readonly eventId: string;
    readonly intent: string;
    readonly method: "PATCH" | "POST";
    readonly path: string;
  } | undefined;
  let submissionRecoveryUnresolved = false;
  let pendingGuidedSubmission: {
    readonly body: object;
    readonly eventId: string;
  } | undefined;
  let pendingSend: {
    readonly body: object;
    readonly eventId: string;
  } | undefined;
  const pendingDraftRemovals = new Map<string, {
    readonly eventId: string;
    readonly expectedUpdatedAt: string;
    readonly removedAt: string;
  }>();
  const pendingCancellations = new Map<string, {
    readonly cancelledAt: string;
    readonly eventId: string;
  }>();
  const sessionIsTerminal = (): boolean =>
    session?.session.state === "ending" || session?.session.state === "ended";
  const rebuildLinkedTextRanges = (): void => {
    linkedTextRanges.clear();
    const registerContext = (context: readonly ContextSelectionItem[] | null): void => {
      for (const item of context ?? []) {
        if (item.kind !== "textRange") continue;
        linkedTextRanges.set(linkedTextRangeDomId(item), item);
      }
    };
    for (const draft of session?.drafts ?? []) registerContext(draft.context);
    for (const question of session?.questions ?? []) registerContext(question.context);
    const projectedContextId = document
      .querySelector<HTMLElement>("mark[data-linked-text-context]")
      ?.dataset.linkedTextContext;
    if (
      projectedContextId !== undefined &&
      !linkedTextRanges.has(projectedContextId)
    ) clearLinkedTextRange();
  };

  const paintMode = (): void => {
    const selectedMode = selectedComposerMode();
    const learning = selectedMode === "learn";
    const recoveryUnresolved = pendingSend !== undefined || submissionRecoveryUnresolved;
    analyzeMode.setAttribute("aria-pressed", String(!learning));
    learnMode.setAttribute("aria-pressed", String(learning));
    modeDescription.textContent = editingDraftId === undefined
      ? learning
        ? "Learn uses source-backed tutoring without scores or learner profiles."
        : "Analyze gives direct source-backed answers."
      : `Editing ${learning ? "a Learn" : "an Analyze"} draft. New questions remain in ${
          conversationMode === "learn" ? "Learn" : "Analyze"
        } mode.`;
    composerHeading.textContent = learning ? "Continue learning" : "Ask a follow-up";
    composerHint.textContent = learning
      ? "Ask for a simpler explanation, an example, or a connection to another part. Add to queue stays private. Only Send to agent contacts the agent."
      : "Select context for your follow-up. Add to queue stays private. Only Send to agent contacts the agent.";
    contextHeading.textContent = learning ? "Learning focus" : "Selected context";
    label.textContent = learning ? "What would help you understand this?" : "Your question";
    textarea.placeholder = learning
      ? "Explain this more simply, show me an example, or connect it to another part..."
      : "What would you like the agent to explain?";
    const emptyContext = contextSummary.querySelector<HTMLElement>(".empty-context");
    if (emptyContext !== null) {
      emptyContext.textContent = learning
        ? "No learning focus selected - the agent will teach from the whole walkthrough."
        : "No context selected - this question applies to the whole walkthrough.";
    }
    learningControls.hidden = conversationMode !== "learn";
    analyzeMode.disabled =
      session === undefined ||
      sessionIsTerminal() ||
      (requestInFlight && editingDraftId !== undefined) ||
      modeRequestInFlight ||
      modeRecoveryPending ||
      recoveryUnresolved;
    learnMode.disabled =
      session === undefined ||
      sessionIsTerminal() ||
      (requestInFlight && editingDraftId !== undefined) ||
      modeRequestInFlight ||
      modeRecoveryPending ||
      recoveryUnresolved;
  };

  const paintAvailability = (): void => {
    const sessionEnded = sessionIsTerminal();
    const sendUnresolved = pendingSend !== undefined;
    const recoveryUnresolved = sendUnresolved || submissionRecoveryUnresolved;
    contextSelectionAvailable = !sessionEnded && !requestInFlight && !recoveryUnresolved;
    textarea.disabled = sessionEnded || requestInFlight || recoveryUnresolved;
    submit.disabled =
      session === undefined ||
      sessionEnded ||
      requestInFlight ||
      modeRequestInFlight ||
      modeRecoveryPending ||
      sendUnresolved;
    sendToAgent.disabled =
      session === undefined ||
      sessionEnded ||
      requestInFlight ||
      modeRequestInFlight ||
      modeRecoveryPending ||
      submissionRecoveryUnresolved ||
      editingDraftId !== undefined ||
      editingQuestionId !== undefined ||
      (
        pendingSend === undefined &&
        session.drafts.length === 0 &&
        textarea.value.trim() === ""
      );
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-learning-intent]")) {
      button.disabled =
        session === undefined ||
        sessionEnded ||
        requestInFlight ||
        modeRequestInFlight ||
        modeRecoveryPending ||
        recoveryUnresolved;
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "[data-module-selector], [data-line-selector], .context-chip",
    )) button.disabled = sessionEnded || requestInFlight || recoveryUnresolved;
    for (const button of document.querySelectorAll<HTMLButtonElement>(".question-actions button")) {
      button.disabled =
        sessionEnded ||
        requestInFlight ||
        modeRequestInFlight ||
        modeRecoveryPending ||
        recoveryUnresolved;
    }
    discardEdit.disabled = sessionEnded || requestInFlight || recoveryUnresolved;
    paintMode();
  };
  conversationAvailabilityChanged = paintAvailability;

  const applyConversationMode = (mode: ConversationMode): void => {
    if (conversationMode !== mode) modeGeneration += 1;
    conversationMode = mode;
    if (session !== undefined) {
      session = {
        ...session,
        session: { ...session.session, conversationMode: mode },
      };
    }
  };
  const adoptTerminalSessionState = (state: SessionState): boolean => {
    if (session === undefined || state === "active" || session.session.state === "ended") {
      return false;
    }
    if (state === "ending" && session.session.state === "ending") return false;
    session = {
      ...session,
      session: { ...session.session, state },
    };
    paintSessionChrome(state);
    return true;
  };
  const reconcileConversationMode = (force = false): Promise<boolean> => {
    if (!force && !modeRecoveryPending) return Promise.resolve(true);
    if (modeRecoveryRequest !== undefined) return modeRecoveryRequest;
    const requestedGeneration = modeGeneration;
    const request = jsonRequest<SessionView>("/api/session")
      .then((reconciled) => {
        const snapshotSequence = reconciled.events.at(-1)?.sequence ?? 0;
        const terminalStateChanged = adoptTerminalSessionState(reconciled.session.state);
        if (
          requestedGeneration !== modeGeneration ||
          snapshotSequence < modeKnownThroughSequence
        ) {
          if (terminalStateChanged) paintAvailability();
          return false;
        }
        applyConversationMode(reconciled.session.conversationMode);
        modeKnownThroughSequence = Math.max(
          modeKnownThroughSequence,
          snapshotSequence,
        );
        if (modeRecoveryPending) {
          modeRecoveryPending = false;
          modeOutcome.classList.remove("is-error");
          modeOutcome.textContent =
            `${conversationMode === "learn" ? "Learn" : "Analyze"} mode selected.`;
        }
        paintAvailability();
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (modeRecoveryRequest === request) modeRecoveryRequest = undefined;
      });
    modeRecoveryRequest = request;
    return request;
  };
  const scheduleModeRecovery = (): void => {
    if (modeRecoveryTimer !== undefined) return;
    modeRecoveryTimer = window.setTimeout(() => {
      modeRecoveryTimer = undefined;
      void reconcileConversationMode().then((reconciled) => {
        if (!reconciled) scheduleModeRecovery();
      });
    }, 250);
  };
  const recoverConversationMode = (): void => {
    if (modeRecoveryPending && modeRecoveryTimer !== undefined) {
      window.clearTimeout(modeRecoveryTimer);
      modeRecoveryTimer = undefined;
    }
    void reconcileConversationMode(true).then((reconciled) => {
      if (!reconciled && modeRecoveryPending) scheduleModeRecovery();
    });
  };

  const changeConversationMode = async (mode: ConversationMode): Promise<void> => {
    if (editingDraftId !== undefined) {
      editingDraftMode = mode;
      paintMode();
      return;
    }
    if (
      session === undefined ||
      sessionIsTerminal() ||
      modeRequestInFlight ||
      mode === conversationMode
    ) return;
    const previousMode = conversationMode;
    modeSaveGeneration += 1;
    applyConversationMode(mode);
    const requestGeneration = modeGeneration;
    modeRequestInFlight = true;
    modeOutcome.classList.remove("is-error");
    modeOutcome.textContent = `Saving ${mode === "learn" ? "Learn" : "Analyze"} mode...`;
    paintAvailability();
    try {
      const saved = await jsonRequest<{ mode: ConversationMode }>("/api/session/mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (modeGeneration === requestGeneration) applyConversationMode(saved.mode);
      modeOutcome.textContent =
        `${conversationMode === "learn" ? "Learn" : "Analyze"} mode selected.`;
    } catch (error) {
      modeRecoveryPending = true;
      const reconciled = await reconcileConversationMode();
      if (reconciled) {
        if (conversationMode === mode) {
          modeOutcome.textContent = `${mode === "learn" ? "Learn" : "Analyze"} mode selected.`;
          return;
        }
        modeOutcome.classList.add("is-error");
        modeOutcome.textContent = error instanceof Error
          ? error.message
          : "Conversation mode could not be saved.";
        return;
      }
      if (!conversationModeNeedsRecovery()) return;
      applyConversationMode(previousMode);
      modeOutcome.textContent = "Reconnecting to confirm the conversation mode...";
      scheduleModeRecovery();
    } finally {
      modeSaveGeneration += 1;
      modeRequestInFlight = false;
      paintAvailability();
    }
  };
  analyzeMode.addEventListener("click", () => void changeConversationMode("analyze"));
  learnMode.addEventListener("click", () => void changeConversationMode("learn"));
  textarea.addEventListener("input", paintAvailability);

  const paintSelection = (): void => {
    if (currentArtifact === undefined) return;
    const context = selectedContext();
    contextSummary.replaceChildren();
    if (context.length === 0) {
      contextSummary.append(element(
        "span",
        "empty-context",
        selectedComposerMode() === "learn"
          ? "No learning focus selected - the agent will teach from the whole walkthrough."
          : "No context selected - this question applies to the whole walkthrough.",
      ));
    } else {
      for (const item of context) {
        const itemLabel = selectionLabel(item, currentArtifact);
        const remove = element("button", "context-chip", itemLabel);
        remove.type = "button";
        remove.id = contextChipDomId(item);
        remove.setAttribute("aria-label", `Remove ${itemLabel} from selected context`);
        remove.addEventListener("click", () => {
          if (item.kind === "module") selectedModules.delete(item.targetId);
          if (item.kind === "textRange") {
            selectedTextRanges.delete(textRangeKey(item));
            window.getSelection()?.removeAllRanges();
          }
          if (item.kind === "sourceLines") {
            const rangeKey = sourceLineRangeKey(item);
            selectedSourceLineRanges.delete(rangeKey);
            if (lineSelectionAnchor?.rangeKey === rangeKey) lineSelectionAnchor = undefined;
          }
          userSelectionChanged();
        });
        contextSummary.append(remove);
      }
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-module-selector]")) {
      const selected = selectedModules.has(button.dataset.moduleSelector ?? "");
      button.setAttribute("aria-pressed", String(selected));
      button.textContent = selected ? "Selected" : "Select section";
      button.closest(".module")?.classList.toggle("is-context-selected", selected);
    }
    for (const line of document.querySelectorAll<HTMLElement>(".code-line")) {
      const number = Number(line.dataset.line);
      const targetId = line.closest<HTMLElement>("[data-module-id]")?.dataset.moduleId;
      const selected = [...selectedSourceLineRanges.values()].some((selectedRange) =>
        targetId === selectedRange.targetId &&
        number >= selectedRange.startLine &&
        number <= selectedRange.endLine
      );
      line.classList.toggle("is-context-selected", selected);
      line.querySelector<HTMLButtonElement>("[data-line-selector]")
        ?.setAttribute("aria-pressed", String(selected));
    }
  };
  selectionChanged = paintSelection;

  const resetEdit = (): void => {
    editingQuestionId = undefined;
    editingDraftId = undefined;
    editingDraftMode = undefined;
    editingDraftBaseline = undefined;
    pendingSubmission = undefined;
    submissionRecoveryUnresolved = false;
    textarea.value = "";
    submit.textContent = "Add to queue";
    discardEdit.hidden = true;
    restoreContext(null);
    paintAvailability();
  };

  const resetMissingDraftEdit = (): void => {
    if (
      editingDraftId === undefined ||
      session === undefined ||
      session.drafts.some(({ id }) => id === editingDraftId)
    ) return;
    resetEdit();
    outcome.classList.add("is-error");
    outcome.textContent = "This draft is no longer available.";
  };

  const paintDraftQueue = (): void => {
    if (currentArtifact === undefined) return;
    rebuildLinkedTextRanges();
    const drafts = session?.drafts ?? [];
    draftQueue.hidden = drafts.length === 0;
    draftCount.textContent = `${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}`;
    draftList.replaceChildren();
    for (const draft of drafts) {
      const item = element("li", "draft-item");
      item.id = viewerDomId(`draft-${draft.id}`);
      item.dataset.draftId = draft.id;
      const itemHeader = element("div", "draft-item-header");
      itemHeader.append(
        element("span", "draft-position", `Draft ${draft.draftPosition}`),
        element("span", "question-mode", draft.mode === "learn" ? "Learn" : "Analyze"),
      );
      item.append(itemHeader, element("p", "question-copy", draft.message));
      const context = draft.context ?? [];
      if (context.length > 0) {
        const contextReferences = element("p", "question-context");
        for (const [index, value] of context.entries()) {
          if (index > 0) contextReferences.append(document.createTextNode(" · "));
          contextReferences.append(contextReferenceLink(value, currentArtifact));
        }
        item.append(contextReferences);
      }
      const actions = element("div", "question-actions");
      const edit = element("button", undefined, "Edit");
      edit.type = "button";
      edit.addEventListener("click", () => {
        editingQuestionId = undefined;
        editingDraftId = draft.id;
        editingDraftMode = draft.mode;
        editingDraftBaseline = {
          artifactRevision: draft.artifactRevision,
          context: draft.context ?? [],
          selectionGeneration: contextSelectionGeneration,
          updatedAt: draft.updatedAt,
        };
        pendingSubmission = undefined;
        textarea.value = draft.message;
        submit.textContent = "Save draft";
        discardEdit.hidden = false;
        restoreContext(draft.context);
        paintAvailability();
        textarea.focus();
      });
      const remove = element("button", "remove-draft", "Remove");
      remove.type = "button";
      remove.addEventListener("click", () => void removeDraft(draft.id));
      actions.append(edit, remove);
      item.append(actions);
      draftList.append(item);
    }
  };

  const paintConversation = (): void => {
    if (currentArtifact === undefined) return;
    rebuildLinkedTextRanges();
    const presentationState = capturePresentationState();
    const questions = session?.questions ?? [];
    const agentWorking = questions.some(({ state }) =>
      state === "leased" || state === "acknowledged"
    );
    agentStatus.textContent = agentWorking ? "Working" : "Waiting";
    agentStatus.dataset.state = agentWorking ? "working" : "waiting";
    conversationCount.textContent = `${questions.length} ${questions.length === 1 ? "question" : "questions"}`;
    emptyConversation.hidden = questions.length > 0;
    conversationList.replaceChildren();
    for (const question of questions) {
      const state = questionState(question, session?.statuses ?? []);
      const item = element("li", `conversation-item state-${state}`);
      item.id = viewerDomId(`question-${question.id}`);
      item.dataset.questionId = question.id;
      const itemHeader = element("div", "conversation-item-header");
      itemHeader.append(
        element("span", "queue-position", `Question ${question.queuePosition}`),
        element("span", "question-mode", question.mode === "learn" ? "Learn" : "Analyze"),
        element("span", "question-state", state),
      );
      item.append(itemHeader, element("p", "question-copy", question.message));
      const context = question.context ?? [];
      if (context.length > 0) {
        const contextReferences = element("p", "question-context");
        for (const [index, value] of context.entries()) {
          if (index > 0) contextReferences.append(document.createTextNode(" · "));
          contextReferences.append(contextReferenceLink(value, currentArtifact));
        }
        item.append(contextReferences);
      }
      const matchingReply = session?.replies.find(({ questionId }) => questionId === question.id);
      if (matchingReply !== undefined) {
        item.append(matchingReply.outcome === "answer"
          ? markdown(replyText(matchingReply.content), "answer-copy")
          : element("p", "failure-copy", replyText(matchingReply.content)));
        const proposedUpdate = replyWalkthroughUpdate(matchingReply.content);
        const updateOutcome = walkthroughUpdateOutcomes.get(question.id);
        if (updateOutcome?.status === "applied") {
          const resultingRevision = updateOutcome.currentRevision ??
            (proposedUpdate === undefined ? "the next revision" : proposedUpdate.expectedRevision + 1);
          item.append(element(
            "p",
            "walkthrough-update-result is-applied",
            `This answer updated the walkthrough to content v${resultingRevision}.`,
          ));
        } else if (updateOutcome?.status === "rejected" && updateOutcome.error !== undefined) {
          item.append(element(
            "p",
            "walkthrough-update-result is-rejected",
            `Walkthrough update not applied. Expected content v${updateOutcome.error.expectedRevision}; current content v${updateOutcome.error.currentRevision}. Retry against the current content version.`,
          ));
        } else if (proposedUpdate !== undefined) {
          item.append(element(
            "p",
            "walkthrough-update-result",
            `This answer proposed walkthrough update ${proposedUpdate.id} for content v${proposedUpdate.expectedRevision}.`,
          ));
        }
      }
      if (question.state === "queued") {
        const itemActions = element("div", "question-actions");
        const edit = element("button", undefined, "Edit");
        edit.type = "button";
        edit.id = viewerDomId(`edit-${question.id}`);
        edit.addEventListener("click", () => {
          editingQuestionId = question.id;
          editingDraftId = undefined;
          editingDraftMode = undefined;
          editingDraftBaseline = undefined;
          pendingSubmission = undefined;
          textarea.value = question.message;
          submit.textContent = "Save question";
          discardEdit.hidden = false;
          restoreContext(question.context);
          paintAvailability();
          textarea.focus();
        });
        const cancel = element("button", "cancel-question", "Cancel");
        cancel.type = "button";
        cancel.id = viewerDomId(`cancel-${question.id}`);
        cancel.addEventListener("click", () => void cancelQuestion(question.id));
        itemActions.append(edit, cancel);
        item.append(itemActions);
      }
      conversationList.append(item);
    }
    restorePresentationState(presentationState);
    restoreLinkedTextRangeFromHash();
  };

  const reconcileGuidedSubmission = (): boolean => {
    const pending = pendingGuidedSubmission;
    if (pending === undefined || !session?.questions.some(({ id }) => id === pending.eventId)) {
      return false;
    }
    pendingGuidedSubmission = undefined;
    learningOutcome.classList.remove("is-error");
    learningOutcome.textContent = "Request queued without changing a learner profile.";
    checkMenu.open = false;
    return true;
  };
  const pendingGuidedEventId = (): string | undefined => pendingGuidedSubmission?.eventId;

  const refresh = async (): Promise<boolean> => {
    try {
      const requestedModeGeneration = modeGeneration;
      const requestedModeSaveGeneration = modeSaveGeneration;
      const refreshedResponse = await jsonRequest<
        Omit<SessionView, "drafts"> & { readonly drafts?: readonly DraftView[] }
      >("/api/session");
      const refreshed: SessionView = {
        ...refreshedResponse,
        drafts: refreshedResponse.drafts ?? [],
      };
      const snapshotSequence = refreshed.events.at(-1)?.sequence ?? 0;
      const currentSnapshotSequence = session?.events.at(-1)?.sequence ?? 0;
      if (
        snapshotSequence <
          Math.max(sessionKnownThroughSequence, currentSnapshotSequence)
      ) return true;
      sessionKnownThroughSequence = snapshotSequence;
      const modeSnapshotIsCurrent =
        !modeRequestInFlight &&
        requestedModeGeneration === modeGeneration &&
        requestedModeSaveGeneration === modeSaveGeneration &&
        snapshotSequence >= modeKnownThroughSequence;
      session = modeSnapshotIsCurrent
        ? refreshed
        : {
            ...refreshed,
            session: { ...refreshed.session, conversationMode },
          };
      if (modeSnapshotIsCurrent) {
        applyConversationMode(refreshed.session.conversationMode);
        modeKnownThroughSequence = Math.max(
          modeKnownThroughSequence,
          snapshotSequence,
        );
      }
      resetMissingDraftEdit();
      paintSessionChrome(session.session.state);
      paintAvailability();
      walkthroughUpdateOutcomes.clear();
      for (const record of session.walkthroughUpdateOutcomes ?? []) {
        walkthroughUpdateOutcomes.set(record.questionId, record.outcome);
      }
      paintDraftQueue();
      paintConversation();
      for (const [draftId, removal] of pendingDraftRemovals) {
        if (
          !session.drafts.some(({ id }) => id === draftId) &&
          session.events.some(({ id }) => id === removal.eventId)
        ) {
          pendingDraftRemovals.delete(draftId);
          if (editingDraftId === draftId) resetEdit();
          outcome.classList.remove("is-error");
          outcome.textContent = "Draft removed.";
        }
      }
      const reconciledCancellation = session.questions.find(
        (question) => question.state === "cancelled" && pendingCancellations.has(question.id),
      );
      if (reconciledCancellation !== undefined) {
        pendingCancellations.delete(reconciledCancellation.id);
        if (editingQuestionId === reconciledCancellation.id) resetEdit();
        outcome.classList.remove("is-error");
        outcome.textContent = "Question cancelled.";
      }
      const reconciledDraftSubmission = session.events.find(
        ({ id, type }) =>
          id === pendingSubmission?.eventId &&
          (type === "draft_created" || type === "draft_updated"),
      );
      if (reconciledDraftSubmission !== undefined) {
        const created = reconciledDraftSubmission.type === "draft_created";
        const draftStillQueued = session.drafts.some(
          ({ id }) => id === reconciledDraftSubmission.id,
        );
        resetEdit();
        outcome.classList.remove("is-error");
        outcome.textContent = created
          ? draftStillQueued
            ? "Draft added to queue."
            : "Draft saved and already processed."
          : "Draft updated.";
      }
      if (
        pendingSend !== undefined &&
        session.events.some(({ id, type }) => id === pendingSend?.eventId && type === "drafts_sent")
      ) {
        pendingSend = undefined;
        textarea.value = "";
        restoreContext(null);
        outcome.classList.remove("is-error");
        outcome.textContent = "Questions sent to agent.";
      }
      reconcileGuidedSubmission();
      paintAvailability();
      return true;
    } catch (error) {
      if (!requestInFlight && !submissionRecoveryUnresolved && pendingSend === undefined) {
        outcome.textContent = error instanceof Error ? error.message : "Conversation could not be refreshed.";
        outcome.classList.add("is-error");
      }
      return false;
    }
  };

  const removeDraft = async (draftId: string): Promise<void> => {
    if (requestInFlight) return;
    requestInFlight = true;
    paintAvailability();
    const expectedUpdatedAt = session?.drafts.find(({ id }) => id === draftId)?.updatedAt;
    if (expectedUpdatedAt === undefined) {
      requestInFlight = false;
      await refresh();
      paintAvailability();
      return;
    }
    let removal = pendingDraftRemovals.get(draftId);
    if (removal === undefined || removal.expectedUpdatedAt !== expectedUpdatedAt) {
      removal = {
        eventId: newStableId("draft-removed"),
        expectedUpdatedAt,
        removedAt: timestampAfter(expectedUpdatedAt),
      };
      pendingDraftRemovals.set(draftId, removal);
    }
    const sendRemoval = (): Promise<unknown> => jsonRequest(`/api/drafts/${draftId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(removal),
    });
    try {
      try {
        await sendRemoval();
      } catch {
        await sendRemoval();
      }
      pendingDraftRemovals.delete(draftId);
      if (editingDraftId === draftId) resetEdit();
      outcome.classList.remove("is-error");
      outcome.textContent = "Draft removed.";
      await refresh();
    } catch (error) {
      await refresh();
      outcome.classList.add("is-error");
      outcome.textContent = error instanceof Error ? error.message : "Draft could not be removed.";
    } finally {
      requestInFlight = false;
      paintAvailability();
    }
  };

  const cancelQuestion = async (questionId: string): Promise<void> => {
    if (requestInFlight) return;
    requestInFlight = true;
    paintAvailability();
    let cancellation = pendingCancellations.get(questionId);
    if (cancellation === undefined) {
      cancellation = {
        eventId: newStableId("question-cancelled"),
        cancelledAt: new Date().toISOString(),
      };
      pendingCancellations.set(questionId, cancellation);
    }
    const sendCancellation = (): Promise<unknown> => jsonRequest(`/api/questions/${questionId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cancellation),
    });
    try {
      try {
        await sendCancellation();
      } catch {
        await sendCancellation();
      }
      pendingCancellations.delete(questionId);
      if (editingQuestionId === questionId) resetEdit();
      outcome.classList.remove("is-error");
      outcome.textContent = "Question cancelled.";
      await refresh();
    } catch (error) {
      outcome.classList.add("is-error");
      outcome.textContent = error instanceof Error ? error.message : "Question could not be cancelled.";
    } finally {
      requestInFlight = false;
      paintAvailability();
    }
  };

  const queueGuidedQuestion = async (message: string): Promise<void> => {
    const artifactRevision = currentArtifact?.revision;
    if (
      requestInFlight ||
      modeRequestInFlight ||
      submissionRecoveryUnresolved ||
      session === undefined ||
      sessionIsTerminal() ||
      artifactRevision === undefined
    ) return;
    requestInFlight = true;
    const context = selectedContext();
    paintAvailability();
    const retrying = pendingGuidedSubmission !== undefined;
    if (pendingGuidedSubmission === undefined) {
      const eventId = newStableId("learning-request");
      pendingGuidedSubmission = {
        eventId,
        body: {
          schemaVersion: 1,
          eventId,
          sessionId: session.session.id,
          artifactRevision,
          createdAt: new Date().toISOString(),
          type: "question",
          mode: "learn",
          message,
          ...(context.length === 0 ? {} : { contextSelection: context }),
        },
      };
    }
    const submission = pendingGuidedSubmission;
    learningOutcome.classList.remove("is-error");
    learningOutcome.textContent = retrying ? "Retrying previous request..." : "Saving request...";
    try {
      await jsonRequest("/api/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.body),
      });
      await refreshArtifact([], true);
      await refresh();
      if (pendingGuidedEventId() === submission.eventId) {
        throw new Error("The request was saved, but its durable state could not be refreshed.");
      }
    } catch (error) {
      if (pendingGuidedEventId() === submission.eventId && !reconcileGuidedSubmission()) {
        learningOutcome.classList.add("is-error");
        learningOutcome.textContent = error instanceof Error ? error.message : "Request could not be queued.";
      }
    } finally {
      requestInFlight = false;
      paintAvailability();
    }
  };

  simpler.addEventListener("click", () => void queueGuidedQuestion(
    "Explain the selected context more simply. Keep the source facts intact and do not infer my skill level.",
  ));
  deeper.addEventListener("click", () => void queueGuidedQuestion(
    "Give me a deeper technical explanation of the selected context with source-backed details.",
  ));
  for (const button of checkButtons) {
    button.addEventListener("click", () => void queueGuidedQuestion(button.dataset.prompt ?? ""));
  }

  discardEdit.addEventListener("click", resetEdit);
  textarea.addEventListener("keydown", (event) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.isComposing ||
      (!event.metaKey && !event.ctrlKey)
    ) return;
    event.preventDefault();
    if (!sendToAgent.disabled) sendToAgent.click();
  });
  composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const artifactRevision = currentArtifact?.revision;
    if (
      requestInFlight ||
      modeRequestInFlight ||
      pendingSend !== undefined ||
      session === undefined ||
      sessionIsTerminal() ||
      artifactRevision === undefined
    ) return;
    const message = textarea.value.trim();
    if (message === "") return;
    if (editingQuestionId !== undefined) {
      requestInFlight = true;
      submit.disabled = true;
      outcome.classList.remove("is-error");
      outcome.textContent = "Saving changes...";
      paintAvailability();
      const context = selectedContext();
      const editing = editingQuestionId;
      const intent = JSON.stringify({ editing, message, context });
      if (pendingSubmission?.intent !== intent) {
        const eventId = newStableId("question-edited");
        pendingSubmission = {
          eventId,
          intent,
          method: "PATCH",
          path: `/api/questions/${editing}`,
          body: {
            eventId,
            updatedAt: new Date().toISOString(),
            message,
            contextSelection: context,
          },
        };
        submissionRecoveryUnresolved = false;
      }
      const submission = pendingSubmission;
      void jsonRequest(submission.path, {
        method: submission.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission.body),
      }).then(async () => {
        resetEdit();
        requestInFlight = false;
        outcome.textContent = "Question updated.";
        paintAvailability();
        await refresh();
      }).catch(async (error: unknown) => {
        const refreshed = await refresh();
        if (session?.events.some(({ id }) => id === submission.eventId)) {
          resetEdit();
          outcome.classList.remove("is-error");
          outcome.textContent = "Question updated.";
        } else {
          submissionRecoveryUnresolved = !refreshed;
          outcome.classList.add("is-error");
          outcome.textContent = error instanceof Error ? error.message : "Question could not be saved.";
        }
        requestInFlight = false;
        paintAvailability();
      });
      return;
    }
    requestInFlight = true;
    submit.disabled = true;
    outcome.classList.remove("is-error");
    outcome.textContent = editingDraftId === undefined ? "Adding draft..." : "Saving draft...";
    paintAvailability();
    const context = selectedContext();
    const editing = editingDraftId;
    const draftMode = editingDraftMode ?? conversationMode;
    const editingBaseline = editingDraftBaseline;
    const editingDraft = editing === undefined
      ? undefined
      : session.drafts.find(({ id }) => id === editing);
    if (
      editing !== undefined &&
      (editingDraft === undefined || editingBaseline === undefined)
    ) {
      requestInFlight = false;
      resetEdit();
      outcome.classList.add("is-error");
      outcome.textContent = "This draft is no longer available.";
      return;
    }
    const draftContext =
      editingBaseline !== undefined &&
        contextSelectionGeneration === editingBaseline.selectionGeneration
        ? [...editingBaseline.context]
        : context;
    const draftArtifactRevision =
      editingBaseline !== undefined &&
        contextSelectionGeneration === editingBaseline.selectionGeneration
        ? editingBaseline.artifactRevision
        : artifactRevision;
    const expectedUpdatedAt = editingBaseline?.updatedAt;
    const intent = JSON.stringify({
      editing: editing ?? null,
      message,
      context: draftContext,
      ...(editing === undefined
        ? {}
        : { artifactRevision: draftArtifactRevision, expectedUpdatedAt, mode: draftMode }),
    });
    if (pendingSubmission?.intent !== intent) {
      const timestamp = editingBaseline === undefined
        ? new Date().toISOString()
        : timestampAfter(editingBaseline.updatedAt);
      const eventId = newStableId(editingBaseline === undefined ? "draft" : "draft-edited");
      pendingSubmission = editingBaseline === undefined
        ? {
            eventId,
            intent,
            method: "POST",
            path: "/api/drafts",
            body: {
              schemaVersion: 1,
              eventId,
              sessionId: session.session.id,
              artifactRevision,
              createdAt: timestamp,
              type: "question",
              mode: conversationMode,
              message,
              ...(draftContext.length === 0 ? {} : { contextSelection: draftContext }),
            },
          }
        : {
            eventId,
            intent,
            method: "PATCH",
            path: `/api/drafts/${editing}`,
            body: {
              eventId,
              expectedUpdatedAt: editingBaseline.updatedAt,
              artifactRevision: draftArtifactRevision,
              updatedAt: timestamp,
              mode: draftMode,
              message,
              contextSelection: draftContext,
            },
          };
      submissionRecoveryUnresolved = false;
    }
    const submission = pendingSubmission;
    void jsonRequest(submission.path, {
      method: submission.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission.body),
    }).then(async () => {
      resetEdit();
      requestInFlight = false;
      paintAvailability();
      outcome.textContent = editing === undefined ? "Draft added to queue." : "Draft updated.";
      await refresh();
    }).catch(async (error: unknown) => {
      await refresh();
      const saved = session?.events.some(({ id }) => id === submission.eventId);
      if (saved) {
        const draftStillQueued = session?.drafts.some(({ id }) => id === submission.eventId);
        resetEdit();
        outcome.classList.remove("is-error");
        outcome.textContent = editing === undefined
          ? draftStillQueued
            ? "Draft added to queue."
            : "Draft saved and already processed."
          : "Draft updated.";
      } else {
        const definitiveFailure = isDefinitiveRequestFailure(error);
        if (definitiveFailure && pendingSubmission?.eventId === submission.eventId) {
          pendingSubmission = undefined;
        }
        submissionRecoveryUnresolved = !definitiveFailure;
        outcome.classList.add("is-error");
        outcome.textContent = error instanceof Error ? error.message : "Draft could not be saved.";
      }
      requestInFlight = false;
      paintAvailability();
    });
  });

  sendToAgent.addEventListener("click", () => {
    const artifactRevision = currentArtifact?.revision;
    if (
      requestInFlight ||
      modeRequestInFlight ||
      submissionRecoveryUnresolved ||
      session === undefined ||
      sessionIsTerminal() ||
      editingDraftId !== undefined ||
      editingQuestionId !== undefined ||
      artifactRevision === undefined
    ) return;
    const message = textarea.value.trim();
    if (pendingSend === undefined && session.drafts.length === 0 && message === "") return;
    const context = selectedContext();
    if (pendingSend === undefined) {
      const eventId = newStableId("drafts-sent");
      pendingSend = {
        eventId,
        body: {
          eventId,
          sentAt: new Date().toISOString(),
          drafts: session.drafts.map(({ id, updatedAt }) => ({ id, updatedAt })),
          composer: message === ""
            ? null
            : {
                artifactRevision,
                message,
                contextSelection: context,
              },
        },
      };
    }
    const submission = pendingSend;
    requestInFlight = true;
    outcome.classList.remove("is-error");
    outcome.textContent = "Sending questions...";
    paintAvailability();
    void jsonRequest("/api/drafts/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submission.body),
    }).then(async () => {
      pendingSend = undefined;
      textarea.value = "";
      restoreContext(null);
      requestInFlight = false;
      outcome.textContent = "Questions sent to agent.";
      paintAvailability();
      await refreshArtifact([], true);
      await refresh();
    }).catch(async (error: unknown) => {
      await refresh();
      if (pendingSend?.eventId === submission.eventId) {
        if (isDefinitiveRequestFailure(error)) pendingSend = undefined;
        outcome.classList.add("is-error");
        outcome.textContent = error instanceof Error ? error.message : "Questions could not be sent.";
      }
      requestInFlight = false;
      paintAvailability();
    });
  });

  const initialRefresh = refresh();
  conversationEventApply = async (event): Promise<void> => {
    await initialRefresh;
    if (session === undefined) await refresh();
    if (session === undefined) throw new Error("Conversation snapshot is unavailable");
    if (event.type === "walkthrough_update_recorded") {
      if (event.walkthroughUpdate === undefined) throw new Error("SSE Walkthrough Update outcome is missing");
      walkthroughUpdateOutcomes.set(event.entityId, event.walkthroughUpdate);
      paintConversation();
      sessionKnownThroughSequence = Math.max(sessionKnownThroughSequence, event.sequence);
      return;
    }
    if (event.type.startsWith("draft_") || event.type === "drafts_sent") {
      if (event.sequence <= (session.events.at(-1)?.sequence ?? 0)) {
        sessionKnownThroughSequence = Math.max(sessionKnownThroughSequence, event.sequence);
        return;
      }
      const recordedEvent = { id: event.id, sequence: event.sequence, type: event.type };
      const events = [
        ...session.events.filter(({ id }) => id !== event.id),
        recordedEvent,
      ].sort((left, right) => left.sequence - right.sequence);
      if (event.type === "draft_created" || event.type === "draft_updated") {
        const draft = event.data?.draft;
        if (draft === undefined || draft.id !== event.entityId) {
          throw new Error("SSE draft record is missing");
        }
        session = {
          ...session,
          drafts: [
            ...session.drafts.filter(({ id }) => id !== draft.id),
            draft,
          ].sort((left, right) => left.draftPosition - right.draftPosition),
          events,
        };
      } else {
        session = {
          ...session,
          drafts: event.type === "draft_removed"
            ? session.drafts.filter(({ id }) => id !== event.entityId)
            : [],
          events,
        };
      }
      resetMissingDraftEdit();
      const pendingRemoval = pendingDraftRemovals.get(event.entityId);
      if (event.type === "draft_removed" && pendingRemoval?.eventId === event.id) {
        pendingDraftRemovals.delete(event.entityId);
        if (editingDraftId === event.entityId) resetEdit();
        outcome.classList.remove("is-error");
        outcome.textContent = "Draft removed.";
      }
      if (event.type === "drafts_sent" && pendingSend?.eventId === event.id) {
        pendingSend = undefined;
        textarea.value = "";
        restoreContext(null);
        outcome.classList.remove("is-error");
        outcome.textContent = "Questions sent to agent.";
      }
      if (
        (event.type === "draft_created" || event.type === "draft_updated") &&
        pendingSubmission?.eventId === event.id
      ) {
        const created = event.type === "draft_created";
        resetEdit();
        outcome.classList.remove("is-error");
        outcome.textContent = created ? "Draft added to queue." : "Draft updated.";
      }
      sessionKnownThroughSequence = Math.max(sessionKnownThroughSequence, event.sequence);
      paintDraftQueue();
      paintAvailability();
      return;
    }
    const questionEvent = event.type.startsWith("question_") || event.type === "lease_expired";
    if (questionEvent) {
      if (event.record === undefined) throw new Error("SSE question record is missing");
      const question = event.record as QuestionView;
      const existingIndex = session.questions.findIndex(({ id }) => id === question.id);
      const existingQuestion = session.questions[existingIndex];
      if (existingQuestion === undefined || JSON.stringify(existingQuestion) !== JSON.stringify(question)) {
        session = {
          ...session,
          questions: existingIndex < 0
            ? [...session.questions, question].sort((left, right) => left.queuePosition - right.queuePosition)
            : session.questions.map((candidate) => candidate.id === question.id ? question : candidate),
        };
        paintConversation();
      }
      reconcileGuidedSubmission();
    } else if (event.type === "status_recorded") {
      if (event.record === undefined) throw new Error("SSE status record is missing");
      const status = event.record as StatusView;
      session = {
        ...session,
        questions: session.questions.map((question) => question.id === status.questionId
          ? { ...question, state: "acknowledged" }
          : question),
        statuses: [
          ...session.statuses.filter(({ id }) => id !== status.id),
          status,
        ],
      };
      paintConversation();
    } else if (event.type === "reply_recorded") {
      if (event.record === undefined) throw new Error("SSE reply record is missing");
      const reply = event.record as ReplyView;
      if (event.walkthroughUpdate !== undefined) {
        walkthroughUpdateOutcomes.set(reply.questionId, event.walkthroughUpdate);
      }
      session = {
        ...session,
        questions: session.questions.map((question) => question.id === reply.questionId
          ? { ...question, state: reply.outcome === "answer" ? "answered" : "failed" }
          : question),
        replies: [
          ...session.replies.filter(({ questionId }) => questionId !== reply.questionId),
          reply,
        ],
      };
      paintConversation();
    } else if (event.type === "conversation_mode_changed") {
      if (event.sequence <= modeKnownThroughSequence) {
        sessionKnownThroughSequence = Math.max(sessionKnownThroughSequence, event.sequence);
        return;
      }
      const mode = event.data?.mode;
      if (mode !== "analyze" && mode !== "learn") {
        throw new Error("SSE conversation mode event is invalid");
      }
      applyConversationMode(mode);
      modeKnownThroughSequence = event.sequence;
      modeRecoveryPending = false;
      if (modeRecoveryTimer !== undefined) {
        window.clearTimeout(modeRecoveryTimer);
        modeRecoveryTimer = undefined;
      }
      modeOutcome.classList.remove("is-error");
      modeOutcome.textContent = `${mode === "learn" ? "Learn" : "Analyze"} mode selected.`;
      paintAvailability();
    } else if (event.type === "session_transitioned" && event.data?.to !== undefined) {
      session = { ...session, session: { ...session.session, state: event.data.to } };
      paintSessionChrome(event.data.to);
      paintAvailability();
    }
    sessionKnownThroughSequence = Math.max(sessionKnownThroughSequence, event.sequence);
  };
  paintAvailability();
  return {
    conversation,
    focusComposer: () => {
      setConversationOpen(true);
      if (textarea.disabled) conversation.focus();
      else textarea.focus();
    },
    reconcileMode: recoverConversationMode,
    refresh,
  };
}

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function themeControl(): HTMLButtonElement {
  const themes: Theme[] = ["system", "light", "dark"];
  let current: Theme = "system";
  const button = element("button", "theme-control");
  button.type = "button";
  button.id = viewerDomId("theme-control");
  const update = (): void => {
    applyTheme(current);
    button.textContent = `Theme: ${current}`;
    button.setAttribute("aria-label", `Color theme is ${current}. Activate to change it.`);
  };
  button.addEventListener("click", () => {
    const index = themes.indexOf(current);
    current = themes[(index + 1) % themes.length] ?? "system";
    update();
  });
  update();
  return button;
}

function endSessionControl(): HTMLElement {
  const wrapper = element("div", "end-session-control");
  const button = element("button", "end-session-button", "End session");
  button.type = "button";
  const outcome = element("span", "end-session-outcome");
  outcome.setAttribute("role", "status");
  button.addEventListener("click", () => {
    button.disabled = true;
    outcome.textContent = "Ending...";
    void jsonRequest<{ readonly status: string }>("/api/session/end", { method: "POST" })
      .then(async () => {
        outcome.textContent = "Session ended.";
        button.textContent = "Session ended";
        await persistentConversationStudio?.refresh();
      })
      .catch((error: unknown) => {
        button.disabled = false;
        outcome.textContent = error instanceof Error ? error.message : "Session could not be ended.";
      });
  });
  wrapper.append(button, outcome);
  return wrapper;
}

interface ViewerPresentationState {
  readonly activeElement?:
    | { readonly id: string }
    | { readonly href: string; readonly occurrence: number; readonly scopeId?: string };
  readonly details: readonly boolean[];
  readonly scrollX: number;
  readonly scrollY: number;
  readonly textareas: readonly {
    readonly end: number | null;
    readonly id: string;
    readonly start: number | null;
    readonly value: string;
  }[];
}

function capturePresentationState(): ViewerPresentationState {
  const activeElement = document.activeElement;
  let activeElementState: ViewerPresentationState["activeElement"];
  if (activeElement instanceof HTMLElement && activeElement.id !== "") {
    activeElementState = { id: activeElement.id };
  } else if (activeElement instanceof HTMLAnchorElement) {
    const href = activeElement.getAttribute("href");
    if (href !== null) {
      const scope = activeElement.parentElement?.closest<HTMLElement>("[id]");
      const matchingLinks = [...(scope ?? document).querySelectorAll<HTMLAnchorElement>("a[href]")]
        .filter((link) => link.getAttribute("href") === href);
      const occurrence = matchingLinks.indexOf(activeElement);
      if (occurrence >= 0) {
        activeElementState = {
          href,
          occurrence,
          ...(scope === null || scope === undefined ? {} : { scopeId: scope.id }),
        };
      }
    }
  }
  return {
    ...(activeElementState === undefined ? {} : { activeElement: activeElementState }),
    details: [...document.querySelectorAll("details")].map(({ open }) => open),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    textareas: [...document.querySelectorAll<HTMLTextAreaElement>("textarea[id]")].map((textarea) => ({
      end: textarea.selectionEnd,
      id: textarea.id,
      start: textarea.selectionStart,
      value: textarea.value,
    })),
  };
}

function restorePresentationState(state: ViewerPresentationState): void {
  for (const [index, details] of [...document.querySelectorAll("details")].entries()) {
    details.open = state.details[index] ?? details.open;
  }
  for (const saved of state.textareas) {
    const textarea = document.getElementById(saved.id);
    if (!(textarea instanceof HTMLTextAreaElement)) continue;
    textarea.value = saved.value;
    if (saved.start !== null && saved.end !== null) textarea.setSelectionRange(saved.start, saved.end);
  }
  if (state.activeElement !== undefined) {
    const focusTarget = state.activeElement;
    const activeElement = "id" in focusTarget
      ? document.getElementById(focusTarget.id)
      : [...(focusTarget.scopeId === undefined
        ? document
        : document.getElementById(focusTarget.scopeId) ?? document
      ).querySelectorAll<HTMLAnchorElement>("a[href]")]
        .filter((link) => link.getAttribute("href") === focusTarget.href)
        .at(focusTarget.occurrence);
    activeElement?.focus({ preventScroll: true });
  }
  window.scrollTo({
    behavior: "instant",
    left: state.scrollX,
    top: state.scrollY,
  });
}

function artifactItem(
  artifact: WalkthroughArtifact,
  targetId: string,
): Record<string, unknown> | undefined {
  for (const module of artifact.sections) {
    if (module.id === targetId) return module;
    const annotation = module.annotations?.find(({ id }) => id === targetId);
    if (annotation !== undefined) return annotation;
    const nested = module.type === "systemFlow"
      ? module.nodes
      : module.type === "sourceExcerpt"
        ? module.highlights
        : module.type === "requestSequence" ||
            module.type === "valueTrace" ||
            module.type === "executionTrace"
          ? module.steps
          : [];
    const item = nested.find(({ id }) => id === targetId);
    if (item !== undefined) return item;
  }
  return undefined;
}

function artifactText(artifact: WalkthroughArtifact, targetId: string, fieldPath: string): string | undefined {
  const item = artifactItem(artifact, targetId);
  if (item === undefined) return;
  const [field, indexText, ...remainder] = fieldPath.split(".");
  if (field === undefined || remainder.length > 0) return;
  const value = item[field];
  if (indexText === undefined) return typeof value === "string" ? value : undefined;
  if (!Array.isArray(value) || !/^\d+$/.test(indexText)) return;
  const indexedValue: unknown = value[Number(indexText)];
  return typeof indexedValue === "string" ? indexedValue : undefined;
}

function selectionIsValid(selection: ContextSelectionItem, artifact: WalkthroughArtifact): boolean {
  if (selection.kind === "module") {
    return artifact.sections.some(({ id }) => id === selection.targetId);
  }
  if (selection.kind === "sourceLines") {
    const module = artifact.sections.find(({ id }) => id === selection.targetId);
    return module?.type === "sourceExcerpt" &&
      selection.file === module.sourceEvidence.file &&
      selection.startLine >= module.sourceEvidence.startLine &&
      selection.endLine <= module.sourceEvidence.endLine;
  }
  const source = artifactText(artifact, selection.targetId, selection.field);
  return source !== undefined && Array.from(source)
    .slice(selection.startOffset, selection.endOffset)
    .join("") === selection.selectedText;
}

function preserveValidSelections(artifact: WalkthroughArtifact): void {
  const context = selectedContext().filter((selection) => selectionIsValid(selection, artifact));
  restoreContext(context);
}

function markChangedContent(changedIds: readonly string[]): void {
  for (const id of changedIds) {
    const changed = document.getElementById(artifactDomId(id));
    if (changed === null) continue;
    changed.classList.add("is-semantically-updated");
    window.setTimeout(() => changed.classList.remove("is-semantically-updated"), 4_500);
  }
}

function renderArtifact(
  artifact: WalkthroughArtifact,
  changedIds: readonly string[] = [],
  presentationState?: ViewerPresentationState,
): void {
  if (app === null) return;
  preserveValidSelections(artifact);
  currentArtifact = artifact;
  document.title = `${artifact.title} · Walk Me Through the Code`;
  app.replaceChildren();

  const skipLink = element("a", "skip-link", "Skip to walkthrough");
  skipLink.href = `#${viewerDomId("walkthrough")}`;
  const conversationSkipLink = element("a", "skip-link", "Skip to Conversation");
  conversationSkipLink.href = `#${viewerDomId("question-message")}`;

  const masthead = element("header", "masthead");
  const brand = element("a", "brand", "Walk Me Through the Code");
  brand.href = `#${viewerDomId("top")}`;
  const mastheadActions = element("div", "masthead-actions");
  mastheadActions.append(element("span", "status-pill", "Ready"), themeControl(), endSessionControl());
  masthead.append(brand, mastheadActions);

  const shell = element("div", "page-shell");
  shell.id = viewerDomId("top");
  const hero = element("header", "hero");
  hero.append(element("p", "hero-kicker", "Source-backed walkthrough"));
  const title = element("h1");
  title.append(markdown(artifact.title, "heading-markdown"));
  hero.append(title);
  const repository = element("p", "repository-summary");
  repository.append(
    element("span", undefined, artifact.repositoryState.scope ?? "Repository"),
    document.createTextNode(" · "),
    element("span", "content-version", `walkthrough content v${artifact.revision}`),
    document.createTextNode(" · "),
    element(
      "span",
      "content-version-help",
      "Changes only when the walkthrough content is updated and protects against stale updates.",
    ),
  );
  hero.append(repository);

  const studio = persistentConversationStudio ??= conversationStudio();
  conversationSkipLink.addEventListener("click", (event) => {
    event.preventDefault();
    studio.focusComposer();
  });

  const layout = element("div", "content-layout");
  const navigationItems = sectionNavigationItems(artifact.sections);
  const navigation = stepNavigation(navigationItems);
  const overview = sectionOverview(navigationItems);

  const main = element("main", "walkthrough");
  main.id = viewerDomId("walkthrough");
  main.tabIndex = -1;
  skipLink.addEventListener("click", (event) => {
    event.preventDefault();
    main.focus();
  });
  for (const [index, module] of artifact.sections.entries()) main.append(renderModule(module, index));
  layout.append(overview, navigation, main);
  const readingLayout = element("div", "reading-layout");
  const readingColumn = element("div", "reading-column");
  const footer = element("footer", "footer");
  footer.append(
    element("span", undefined, `Artifact ${artifact.id}`),
    element("span", undefined, `${artifact.sections.length} explanation modules`),
  );
  readingColumn.append(hero, walkthroughGuidance(), layout, footer);
  readingLayout.append(readingColumn, studio.conversation);
  shell.append(readingLayout);
  app.append(skipLink, conversationSkipLink, masthead, shell);
  trackActiveSection(navigationItems, navigation, overview);
  selectionChanged();
  conversationAvailabilityChanged();
  if (presentationState !== undefined) restorePresentationState(presentationState);
  restoreLinkedTextRangeFromHash();
  markChangedContent(changedIds);
}

function renderError(message: string): void {
  if (app === null) return;
  const error = element("main", "load-error");
  error.append(element("p", "hero-kicker", "Viewer unavailable"), element("h1", undefined, "This Walkthrough could not be loaded."), element("p", undefined, message));
  app.replaceChildren(error);
}

async function refreshArtifact(
  changedIds: readonly string[] = [],
  forceRender = false,
): Promise<void> {
  const response = await fetch("/api/artifact", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`The local runtime returned ${response.status}.`);
  const artifact = await response.json() as WalkthroughArtifact;
  if (!forceRender && currentArtifact?.revision === artifact.revision) {
    markChangedContent(changedIds);
    return;
  }
  const presentationState = currentArtifact === undefined ? undefined : capturePresentationState();
  renderArtifact(artifact, changedIds, presentationState);
}

async function refreshViewer(): Promise<void> {
  await refreshArtifact([], true);
  await persistentConversationStudio?.refresh();
}

async function load(): Promise<void> {
  await refreshArtifact();
  let reconnectSnapshotQueued = false;
  let reconnectSnapshotRequest: Promise<void> | undefined;
  let reconnectSnapshotTimer: number | undefined;
  const reconcileReconnectSnapshot = (): void => {
    if (reconnectSnapshotRequest !== undefined) {
      reconnectSnapshotQueued = true;
      return;
    }
    const studio = persistentConversationStudio;
    if (studio === undefined) return;
    reconnectSnapshotQueued = false;
    const request = studio.refresh()
      .then((reconciled) => {
        if (reconciled) {
          if (reconnectSnapshotTimer !== undefined) {
            window.clearTimeout(reconnectSnapshotTimer);
            reconnectSnapshotTimer = undefined;
          }
          return;
        }
        if (reconnectSnapshotTimer === undefined) {
          reconnectSnapshotTimer = window.setTimeout(() => {
            reconnectSnapshotTimer = undefined;
            reconcileReconnectSnapshot();
          }, 250);
        }
      })
      .finally(() => {
        if (reconnectSnapshotRequest !== request) return;
        reconnectSnapshotRequest = undefined;
        if (reconnectSnapshotQueued) reconcileReconnectSnapshot();
      });
    reconnectSnapshotRequest = request;
  };
  const connectEventStream = (): void => {
    sessionEventReconnectTimer = undefined;
    sessionEventProcessing = Promise.resolve();
    sessionEventSource?.close();
    sessionEventSource = new EventSource("/api/events");
    sessionEventSource.onopen = () => {
      const studio = persistentConversationStudio;
      if (studio === undefined) return;
      reconcileReconnectSnapshot();
      studio.reconcileMode();
    };
    sessionEventSource.onmessage = (event) => {
      const processing = sessionEventProcessing.then(async () => {
        if (typeof event.data !== "string") throw new Error("SSE event data is missing");
        const durableEvent = JSON.parse(event.data) as ConversationDurableEvent;
        if (!Number.isSafeInteger(durableEvent.sequence) || durableEvent.sequence < 1) {
          throw new Error("SSE event sequence is invalid");
        }
        if (durableEvent.walkthroughUpdate?.status === "applied") {
          await refreshArtifact(durableEvent.walkthroughUpdate.changedIds ?? []);
        }
        await conversationEventApply(durableEvent);
        await jsonRequest("/api/events/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lastEventId: durableEvent.sequence }),
        });
      });
      sessionEventProcessing = processing;
      void processing.catch(() => {
        sessionEventSource?.close();
        if (sessionEventReconnectTimer === undefined) {
          sessionEventReconnectTimer = window.setTimeout(connectEventStream, 250);
        }
      });
    };
  };
  reconnectSessionEvents = connectEventStream;
  connectEventStream();
}

Object.defineProperty(window, "WMTCViewer", {
  configurable: false,
  enumerable: false,
  value: Object.freeze({
    reconnectEvents: (): void => reconnectSessionEvents(),
    refreshArtifact: refreshViewer,
  }),
  writable: false,
});

void load().catch((error: unknown) => {
  renderError(error instanceof Error ? error.message : "An unexpected error occurred.");
});
