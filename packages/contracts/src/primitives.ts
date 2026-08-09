import { z } from "zod";

export const CONTRACT_SCHEMA_VERSION = 1 as const;

export const SchemaVersionSchema = z.literal(CONTRACT_SCHEMA_VERSION);

export const StableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)*$/,
    "IDs must be stable, descriptive lowercase tokens",
  )
  .brand<"StableId">();

export type StableId = z.infer<typeof StableIdSchema>;

export const RevisionSchema = z.number().int().nonnegative();
export const TimestampSchema = z.iso.datetime({ offset: true });

export const RepositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\\"), "Paths must use forward slashes")
  .refine(
    (path) =>
      [...path].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
      }),
    "Paths cannot contain control characters",
  )
  .refine(
    (path) => !path.startsWith("/") && !/^[A-Za-z]:/.test(path),
    "Paths must be repository relative",
  )
  .refine(
    (path) => path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Paths cannot contain empty, current-directory, or parent-directory segments",
  );

function isInvalidWindowsPathSegment(segment: string): boolean {
  return (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    /[<>:"|?*]/.test(segment) ||
    /[ .]$/.test(segment) ||
    /^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i.test(segment)
  );
}

export const WindowsRepositoryRelativePathSchema = RepositoryRelativePathSchema.refine(
  (path) => path.split("/").every((segment) => !isInvalidWindowsPathSegment(segment)),
  "Paths must use valid Windows path segments",
);

export const AbsoluteRepositoryPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      [...path].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
      }),
    "Repository root cannot contain control characters",
  )
  .refine(
    (path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"),
    "Repository root must be an absolute path",
  )
  .refine((path) => {
    const invalidSegment = (segment: string): boolean =>
      segment === "" || segment === "." || segment === "..";

    if (path.startsWith("\\\\")) {
      const segments = path.slice(2).split("\\");
      return (
        !path.includes("/") &&
        segments.length >= 2 &&
        segments.every((segment) => !isInvalidWindowsPathSegment(segment))
      );
    }

    if (/^[A-Za-z]:[\\/]/.test(path)) {
      const remainder = path.slice(3);
      return (
        remainder === "" ||
        remainder.split(/[\\/]/).every((segment) => !isInvalidWindowsPathSegment(segment))
      );
    }

    if (path === "/") return true;
    return path
      .slice(1)
      .split("/")
      .every((segment) => !invalidSegment(segment));
  }, "Repository root must use valid canonical path segments");

export const LineRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine(({ startLine, endLine }) => endLine >= startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

export const RESTRICTED_MARKDOWN_FEATURES = [
  "paragraph",
  "heading-1-to-3",
  "ordered-list",
  "unordered-list",
  "blockquote",
  "emphasis",
  "strong",
  "inline-code",
  "fenced-code",
  "link",
  "line-break",
] as const;

function proseOutsideFencedCode(source: string): string {
  const prose: string[] = [];
  let fence: { character: "`" | "~"; length: number } | undefined;

  for (const line of source.split(/\r\n?|\n/)) {
    if (fence !== undefined) {
      const closingFence = line.match(/^ {0,3}(`+|~+)[\t ]*$/);
      if (
        closingFence?.[1]?.[0] === fence.character &&
        closingFence[1].length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const delimiter = openingFence?.[1];
    const info = openingFence?.[2] ?? "";
    if (delimiter !== undefined && (delimiter[0] === "~" || !info.includes("`"))) {
      fence = {
        character: delimiter[0] as "`" | "~",
        length: delimiter.length,
      };
      continue;
    }

    prose.push(line);
  }

  return prose.join("\n");
}

function proseOutsideInlineCode(source: string): string {
  const prose = source.split("");

  function isEscaped(index: number): boolean {
    let backslashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      backslashCount += 1;
    }
    return backslashCount % 2 === 1;
  }

  for (let openingStart = 0; openingStart < source.length; openingStart += 1) {
    if (source[openingStart] !== "`" || isEscaped(openingStart)) continue;

    let delimiterLength = 1;
    while (source[openingStart + delimiterLength] === "`") delimiterLength += 1;

    let closingStart = openingStart + delimiterLength;
    while (closingStart < source.length) {
      if (source[closingStart] !== "`") {
        closingStart += 1;
        continue;
      }

      let closingLength = 1;
      while (source[closingStart + closingLength] === "`") closingLength += 1;
      if (closingLength === delimiterLength) break;
      closingStart += closingLength;
    }

    if (closingStart >= source.length) {
      openingStart += delimiterLength - 1;
      continue;
    }

    const closingEnd = closingStart + delimiterLength;
    for (let index = openingStart; index < closingEnd; index += 1) {
      if (prose[index] !== "\n") prose[index] = " ";
    }
    openingStart = closingEnd - 1;
  }

  return prose.join("");
}

function containsUnsupportedBlock(source: string): boolean {
  return source.split("\n").some((line) => {
    const nestedContents = [line];
    const stripContainerPrefix = (content: string): string | undefined => {
      const withoutBlockquote = content.replace(/^ {0,3}>[\t ]?/, "");
      if (withoutBlockquote !== content) return withoutBlockquote;
      const withoutListMarker = content.replace(
        /^ {0,3}(?:[-+*]|\d{1,9}[.)])[\t ]/,
        "",
      );
      return withoutListMarker === content ? undefined : withoutListMarker;
    };
    let nestedContent = stripContainerPrefix(line);
    while (nestedContent !== undefined) {
      nestedContents.push(nestedContent);
      nestedContent = stripContainerPrefix(nestedContent);
    }

    return nestedContents.some((content) => {
      const isIndentedCode = /^(?: {4,}| {0,3}\t+)[\t ]*\S/.test(content);
      const isDeepHeading = /^ {0,3}#{4,}(?:[\t ]+|$)/.test(content);
      const isSetextHeading = /^ {0,3}(?:=+|-+)[\t ]*$/.test(content);
      const isThematicBreak = /^ {0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/.test(
        content,
      );
      const isTaskList = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[\t ]+\[[ xX]\](?:[\t ]+|$)/.test(
        content,
      );
      const isTableDelimiter = /^ {0,3}\|?[\t ]*:?-{1,}:?[\t ]*(?:\|[\t ]*:?-{1,}:?[\t ]*)+\|?[\t ]*$/.test(
        content,
      );
      const isLinkDefinition = /^ {0,3}\[[^\]]+\]:/.test(content);

      return (
        isIndentedCode ||
        isDeepHeading ||
        isSetextHeading ||
        isThematicBreak ||
        isTaskList ||
        isTableDelimiter ||
        isLinkDefinition
      );
    });
  });
}

function decodeMarkdownCharacterReferences(source: string): string {
  return source
    .replace(
      /&#(?:[xX]([0-9A-Fa-f]{1,6})|([0-9]{1,7}));/g,
      (_reference, hexadecimal: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal === undefined ? 10 : 16);
        return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : "\uFFFD";
      },
    )
    .replace(/&(colon|Tab|NewLine);/g, (reference) => {
      if (reference === "&colon;") return ":";
      if (reference === "&Tab;") return "\t";
      return "\n";
    });
}

const MARKDOWN_ESCAPABLE_PUNCTUATION = /^[!-/:-@[-`{-~]$/;

function normalizeMarkdownBackslashEscapes(source: string): string {
  let normalized = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const escapedCharacter = source[index + 1];
    if (
      character === "\\" &&
      escapedCharacter !== undefined &&
      MARKDOWN_ESCAPABLE_PUNCTUATION.test(escapedCharacter)
    ) {
      normalized += escapedCharacter;
      index += 1;
    } else {
      normalized += character;
    }
  }

  return normalized;
}

function isRestrictedMarkdown(source: string): boolean {
  const prose = proseOutsideInlineCode(proseOutsideFencedCode(source));
  const containsHtml =
    /<!--|<\?|<!\[CDATA\[|<![A-Za-z]|<\/?[A-Za-z][^>]*>|<\/?[A-Za-z][A-Za-z0-9-]*(?=[\t\n\f /]|$)/i.test(
      prose,
    );
  const decodedProse = decodeMarkdownCharacterReferences(normalizeMarkdownBackslashEscapes(prose)).replace(
    /[\t\n\r\f]/g,
    "",
  );
  const containsEmbeddedContent = /!\[|\[[\s\S]*?\]\(\s*(?:javascript|data|file):/i.test(decodedProse);
  return !containsHtml && !containsEmbeddedContent && !containsUnsupportedBlock(prose);
}

export const RestrictedMarkdownSchema = z
  .string()
  .max(100_000)
  .refine(isRestrictedMarkdown, {
    message: "Only Restricted Markdown is allowed; raw HTML and embedded content are rejected",
  })
  .brand<"RestrictedMarkdown">();

export type RestrictedMarkdown = z.infer<typeof RestrictedMarkdownSchema>;

export const RequiredRestrictedMarkdownSchema = RestrictedMarkdownSchema.refine(
  (value) => value.trim().length > 0,
  "Required Markdown content cannot be empty",
);

export const EvidenceLabelSchema = z.enum(["observed", "test-fixture", "illustrative", "inferred"]);

export const ContentHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, "Expected a lowercase sha256 content hash");
