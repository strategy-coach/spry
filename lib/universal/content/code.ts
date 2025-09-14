/**
 * content/code.ts
 * General-purpose "code content" DX:
 *  - Language registry (comment syntax, extensions, shebangs)
 *  - Code-specific governance type
 *  - CodeFileContent wrapper + openCodeFile()
 *  - DX helpers (builders, detection utils)
 *
 * Focus-agnostic: usable for comments, linting, formatting, etc.
 */

import { extname } from "jsr:@std/path@1";

import type {
    Content,
    DefaultPermissions,
    DefaultProvenance,
    GovernanceBase,
} from "./core.ts";
import {
    createFileContent,
    type FileContent,
    type FSGovernance,
} from "./fs.ts";

/* -------------------------------------------------------------------------------------------------
 * Language registry (reusable beyond comments)
 * -----------------------------------------------------------------------------------------------*/

export type CommentStyle = {
    readonly line: readonly string[];
    readonly block: readonly {
        open: string;
        close: string;
        nested?: boolean;
    }[];
};

export type LanguageSpec = {
    readonly id: string;
    readonly aliases?: readonly string[];
    readonly extensions?: readonly string[];
    readonly shebangs?: readonly string[];
    readonly mime?: string;
    /** Minimal info most tooling needs; comments are used by the comments module */
    readonly comment: CommentStyle;
};

const _registry = new Map<string, LanguageSpec>();
const _extIndex = new Map<string, LanguageSpec>();

export function registerLanguage(spec: LanguageSpec): void {
    _registry.set(spec.id, spec);
    for (const ext of spec.extensions ?? []) {
        _extIndex.set(ext.toLowerCase(), spec);
    }
    for (const alias of spec.aliases ?? []) _registry.set(alias, spec);
}

export function getLanguageByIdOrAlias(
    idOrAlias: string,
): LanguageSpec | undefined {
    return _registry.get(idOrAlias);
}

export function detectLanguageByPath(path: string): LanguageSpec | undefined {
    const ext = extname(path).toLowerCase();
    if (!ext) return undefined;
    return _extIndex.get(ext);
}

export function detectLanguageByShebang(
    firstLine: string,
): LanguageSpec | undefined {
    if (!firstLine.startsWith("#!")) return undefined;
    const rest = firstLine.slice(2).trim();
    for (const spec of _registry.values()) {
        for (const s of spec.shebangs ?? []) {
            if (rest.includes(s)) return spec;
        }
    }
    return undefined;
}

/** Preload a solid default set */
(function preloadLanguages() {
    // TS/JS (+ jsonc compatibility)
    registerLanguage({
        id: "typescript",
        aliases: ["ts", "javascript", "js", "tsx", "jsx"],
        extensions: [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            ".jsonc",
            ".json5",
        ],
        shebangs: ["node", "deno"],
        mime: "text/typescript",
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    // JSON (allow //, /* */ for JSONC tooling)
    registerLanguage({
        id: "json",
        extensions: [".json"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "python",
        aliases: ["py"],
        extensions: [".py"],
        shebangs: ["python", "python3", "python2"],
        comment: { line: ["#"], block: [] },
    });
    registerLanguage({
        id: "shell",
        aliases: ["bash", "sh", "zsh"],
        extensions: [".sh", ".bash", ".zsh"],
        shebangs: ["bash", "sh", "zsh"],
        comment: { line: ["#"], block: [] },
    });
    registerLanguage({
        id: "go",
        extensions: [".go"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "rust",
        aliases: ["rs"],
        extensions: [".rs"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: true }],
        },
    });
    registerLanguage({
        id: "java",
        extensions: [".java"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "kotlin",
        aliases: ["kt"],
        extensions: [".kt", ".kts"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "c",
        extensions: [".c", ".h"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "cpp",
        aliases: ["c++", "cc", "hpp"],
        extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hxx"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "html",
        extensions: [".html", ".htm"],
        comment: {
            line: [],
            block: [{ open: "<!--", close: "-->", nested: false }],
        },
    });
    registerLanguage({
        id: "xml",
        extensions: [".xml"],
        comment: {
            line: [],
            block: [{ open: "<!--", close: "-->", nested: false }],
        },
    });
    registerLanguage({
        id: "css",
        extensions: [".css"],
        comment: {
            line: [],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "scss",
        extensions: [".scss", ".sass"],
        comment: {
            line: ["//"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "sql",
        extensions: [".sql"],
        comment: {
            line: ["--"],
            block: [{ open: "/*", close: "*/", nested: false }],
        },
    });
    registerLanguage({
        id: "yaml",
        extensions: [".yaml", ".yml"],
        comment: { line: ["#"], block: [] },
    });
    registerLanguage({
        id: "toml",
        extensions: [".toml"],
        comment: { line: ["#"], block: [] },
    });
    registerLanguage({
        id: "ini",
        extensions: [".ini", ".cfg"],
        comment: { line: [";", "#"], block: [] },
    });
    registerLanguage({
        id: "lua",
        extensions: [".lua"],
        comment: {
            line: ["--"],
            block: [{ open: "--[[", close: "]]", nested: true }],
        },
    });
    registerLanguage({
        id: "r",
        extensions: [".r", ".R"],
        comment: { line: ["#"], block: [] },
    });
})();

/* -------------------------------------------------------------------------------------------------
 * Code governance & content types
 * -----------------------------------------------------------------------------------------------*/

export type CodeGovernance<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    Tags extends readonly string[] = readonly string[],
> = GovernanceBase<A, Prov, Perm, Tags> & {
    readonly code?: {
        readonly languageId: string;
        readonly mime?: string;
        readonly toolchain?: string;
        readonly framework?: string;
    };
};

/** FileContent specialized for code (nature: "text") with language captured. */
export type CodeFileContent<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    Tags extends readonly string[] = readonly string[],
    G extends CodeGovernance<A, Prov, Perm, Tags> = CodeGovernance<
        A,
        Prov,
        Perm,
        Tags
    >,
    P = unknown,
> = FileContent<"text", A, Prov, Perm, Tags, FSGovernance & G, P> & {
    readonly language: LanguageSpec;
};

/* -------------------------------------------------------------------------------------------------
 * DX: openers & builders
 * -----------------------------------------------------------------------------------------------*/

export async function openCodeFile(path: string, opts?: {
    contentId?: string;
    governance?: FSGovernance & CodeGovernance;
    baseDir?: string;
    rel?: string;
    forceLanguageId?: string;
}): Promise<CodeFileContent> {
    let languageSpec = (opts?.forceLanguageId &&
        getLanguageByIdOrAlias(opts.forceLanguageId)) ??
        detectLanguageByPath(path);

    if (!languageSpec) {
        // peek first line for shebang
        try {
            const tmp = createFileContent({
                contentId: opts?.contentId ?? path,
                path,
            });
            const first = await readFirstLine(tmp);
            languageSpec = first ? detectLanguageByShebang(first) : undefined;
            await tmp.close();
        } catch { /* ignore */ }
    }

    if (!languageSpec) languageSpec = getLanguageByIdOrAlias("typescript")!;

    const gov: FSGovernance & CodeGovernance = {
        ...(opts?.governance ?? {}),
        policy: {
            defaultEncoding: "utf-8",
            detectTextByExtension: true,
            ...(opts?.governance?.policy ?? {}),
        },
        code: {
            languageId: languageSpec.id,
            mime: languageSpec.mime,
            ...(opts?.governance?.code ?? {}),
        },
    };

    const fc = createFileContent<
        "text",
        Record<string, unknown>,
        DefaultProvenance,
        DefaultPermissions,
        readonly string[],
        FSGovernance & CodeGovernance
    >({
        contentId: opts?.contentId ?? path,
        path,
        baseDir: opts?.baseDir,
        rel: opts?.rel,
        governance: gov,
        known: { nature: "text" },
    }) as CodeFileContent;

    return Object.freeze({ ...fc, language: languageSpec });
}

async function readFirstLine(c: Content): Promise<string | null> {
    const text = await c.readText(undefined, { range: { start: 0, end: 256 } });
    const i = text.indexOf("\n");
    if (i === -1) return text.length ? text : null;
    return text.slice(0, i);
}

/** Small builder for ergonomics. */
type KnownOpts = { nature?: "text" };
export class CodeFileBuilder<
    A = Record<string, unknown>,
    Prov = DefaultProvenance,
    Perm = DefaultPermissions,
    Tags extends readonly string[] = readonly string[],
    G extends CodeGovernance<A, Prov, Perm, Tags> = CodeGovernance<
        A,
        Prov,
        Perm,
        Tags
    >,
    P = unknown,
> {
    private _id?: string;
    private _path!: string;
    private _gov?: FSGovernance & G;
    private _baseDir?: string;
    private _rel?: string;
    private _known?: KnownOpts;
    private _forceLangId?: string;

    id(id: string) {
        this._id = id;
        return this;
    }
    path(p: string) {
        this._path = p;
        return this;
    }
    baseDir(b: string) {
        this._baseDir = b;
        return this;
    }
    rel(r: string) {
        this._rel = r;
        return this;
    }
    governance(g: FSGovernance & G) {
        this._gov = g;
        return this;
    }
    language(id: string) {
        this._forceLangId = id;
        return this;
    }
    known(k: KnownOpts) {
        this._known = k;
        return this;
    }

    // deno-lint-ignore require-await
    async build(): Promise<CodeFileContent<A, Prov, Perm, Tags, G, P>> {
        if (!this._path) {
            throw new Error("CodeFileBuilder: path() is required.");
        }
        return openCodeFile(this._path, {
            contentId: this._id ?? this._path,
            governance: this._gov,
            baseDir: this._baseDir,
            rel: this._rel,
            forceLanguageId: this._forceLangId,
        }) as Promise<CodeFileContent<A, Prov, Perm, Tags, G, P>>;
    }
}

export function codeFileBuilder() {
    return new CodeFileBuilder();
}
