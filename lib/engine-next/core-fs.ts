// core-fs.ts
import { extname, relative } from "jsr:@std/path@1";
import { walk, type WalkEntry, type WalkOptions } from "jsr:@std/fs@1/walk";
import {
    type EngineEvents,
    type EngineListener,
    type ResourceSupplier,
    SrcCodeLangSpecSupplier,
    type TextSupplier,
} from "./core.ts";
import { type Resource } from "./resource.ts";
import { detectLanguageByPath } from "../universal/content/code.ts";

export type FsWalkedEncounter = {
    readonly supplier: {
        readonly identity?: string;
        readonly root: string;
    };
    readonly walkEntry: WalkEntry;
};

export const isFsWalkedEncounter = (o: unknown): o is FsWalkedEncounter =>
    o && typeof o === "object" && "walkEntry" in o && "supplier" in o &&
        typeof o.walkEntry === "object" && typeof o.supplier === "object"
        ? true
        : false;

export type FsFileResource = Resource & TextSupplier & {
    readonly absFsPath: string;
    readonly relFsPath: string;
    readonly webPath?: string;
    readonly isExecutable: () => Promise<boolean>;
};

export const isFsFileResource = (o: unknown): o is FsFileResource =>
    o && typeof o === "object" && "absFsPath" in o && "isExecutable" in o &&
        typeof o.absFsPath === "string" && typeof o.isExecutable === "function"
        ? true
        : false;

export type FsFilesContributorInit<Identity extends string> = {
    readonly identity: Identity;
    readonly root: string;
    readonly walkOptions?: WalkOptions;
    readonly relFsPath?: (path: string) => string;
    readonly webPath?: (path: string) => string;
};

export function fsFilesContributor<State, Identity extends string>(
    init: FsFilesContributorInit<Identity>,
): EngineListener<EngineEvents<State, Resource>, "resource:contribute"> {
    const { identity, root, walkOptions } = init;
    const ec = executableCandidate();

    const supplier: ResourceSupplier<State, Resource> = async function* (
        { signal },
    ) {
        for await (const walkEntry of walk(root, walkOptions)) {
            const { path: absFsPath } = walkEntry;
            if (signal?.aborted) return;
            const srcCodeLanguage = detectLanguageByPath(absFsPath);
            yield {
                nature: "unknown",
                absFsPath: absFsPath,
                relFsPath: init.relFsPath?.(absFsPath) ??
                    relative(root, absFsPath),
                webPath: init.webPath?.(absFsPath),
                text: async () => await Deno.readTextFile(absFsPath),
                walkEntry,
                supplier: {
                    identity,
                    root,
                },
                srcCodeLanguage,
                isSystemGenerated: false,
                isExecutable: async () =>
                    await ec.isExecutable(absFsPath, extname(absFsPath)),
            } satisfies
                & FsFileResource
                & FsWalkedEncounter
                & Partial<SrcCodeLangSpecSupplier>;
        }
    };

    // deno-lint-ignore require-await
    return (async ({ event }) => {
        event.contribute.register(supplier);
    });
}

/**
 * How to detect executables:
 * - "auto": infer from pathDelim ("\\" => windows, otherwise posix)
 * - "posix": use fs mode x-bits (stat)
 * - "windows": extension in PATHEXT (or a reasonable default set)
 * - "none": skip detection (everything considered non-exec)
 * Default: "auto"
 */
export function executableCandidate(
    executableDetection: "posix" | "windows" | "none" = "posix",
) {
    // cache executability by absolute path to avoid repeat stat/env work
    const execCache = new Map<string, boolean>();

    const isExecutable = async (
        path: string,
        normalizedExt = extname(path),
    ) => {
        // use cache first
        const cached = execCache.get(path);
        if (cached !== undefined) return cached;

        let result = false;

        if (executableDetection === "windows") {
            // Use PATHEXT if available; otherwise a sane default set
            const pathext = (Deno.env.get?.("PATHEXT") ??
                ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1;.PSM1")
                .split(";")
                .map((s) => s.trim().toLowerCase())
                .filter(Boolean);

            result = pathext.includes(normalizedExt.toLowerCase());
        } else if (executableDetection === "posix") {
            try {
                const st = await Deno.stat(path);
                // If it's not a file, treat as non-exec for our purposes
                if (st.isFile && typeof st.mode === "number") {
                    // any x bit (owner/group/other)
                    result = (st.mode & 0o111) !== 0;
                }
            } catch {
                // stat failures => not executable
                result = false;
            }
        } else {
            // "none" => no detection
            result = false;
        }

        execCache.set(path, result);
        return result;
    };

    return { execCache, isExecutable };
}

export class FsFilesCollection<State> {
    readonly suppliers = new Set<ResourceSupplier<State, Resource>>();
    readonly resources: readonly Resource[] = [];
    readonly fsFiles: readonly FsFileResource[] = [];
    readonly walkedFiles: readonly (FsFileResource & FsWalkedEncounter)[] = [];
    readonly execCandidate = executableCandidate();
    readonly isExecutable = this.execCandidate.isExecutable;

    constructor() {
        this.listen = this.onEncountered.bind(this);
    }

    /** Pass to engine.on("resource:encountered", collector.listen) */
    readonly listen: EngineListener<
        EngineEvents<State, Resource>,
        "resource:encountered"
    >;

    // deno-lint-ignore require-await
    protected async onEncountered(
        ev: Parameters<
            EngineListener<
                EngineEvents<State, Resource>,
                "resource:encountered"
            >
        >[0],
    ) {
        const { resource, supplier } = ev.event;
        if (supplier) {
            this.suppliers.add(
                supplier as ResourceSupplier<State, Resource>,
            );
        }
        (this.resources as Resource[]).push(resource);
        if (isFsFileResource(resource)) {
            (this.fsFiles as FsFileResource[]).push(resource);
            if (isFsWalkedEncounter(resource)) {
                (this.walkedFiles as (FsFileResource & FsWalkedEncounter)[])
                    .push(resource);
            }
        }
    }
}
