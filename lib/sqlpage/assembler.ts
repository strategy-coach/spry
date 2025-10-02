import { dirname, fromFileUrl, join, relative, resolve } from "jsr:@std/path@1";
import z from "jsr:@zod/zod@4";
import {
  AnnotatedRoute,
  Assembler,
  AssemblerBusesInit,
  cleaner,
  fsFilesContributor,
  isRouteSupplier,
  isWebPathSupplier,
  Resource,
  resourceSchema,
  ResourcesCollection,
  routeAnnSchema,
  Routes,
  SideAffects,
  typicalAssemblerProjectPropsSchema,
} from "../assembler/mod.ts";
import {
  localDriver,
  ReactiveFs,
  reactiveFs,
  rel,
  RelCanonical,
  rootFs,
  RootLiteral,
} from "../universal/event-fs/mod.ts";
import { flatten, propertiesBag } from "../universal/properties.ts";
import { toSnakeCase } from "npm:drizzle-orm@0.44.5/casing";
import { literal as literalSQL } from "../universal/sql-text.ts";
import { isFsFileResource, isFsSrcCodeFileSupplier } from "../assembler/fs.ts";
import { jsonStringifyReplacers } from "../universal/json-stringify-aide.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

// Only what the subclass adds under `paths`
export const sqlPageProjectPathsSchema = z.object({
  projectSqlDropIn: z.object({
    fsHome: z.string(),
    fsHeadHome: z.string(),
    fsTailHome: z.string(),
  }),
  spryDropIn: z.object({
    fsHome: z.string(),
    fsAuto: z.string(),
    webHome: z.string(),
    webAuto: z.string(),
  }),
  spryStd: z.object({
    fsHomeFromSymlink: z.string(),
    fsHomeAbs: z.string(),
    fsHomeRelToProject: z.string(),
    sqlDropIn: z.object({
      fsHome: z.string(),
      fsHeadHome: z.string(),
      fsTailHome: z.string(),
    }),
  }),
  sqlPage: z.object({
    fsConfDirHome: z.string(),
  }),
  devWatchRoots: z.array(z.string()),
  // functions (e.g., relativeToCWD) are intentionally not modeled here
});

export const sqlPageProjectArtifactsSchema = z.object({
  materialized: z.object({
    // projectPropsAutoSql: z.string().describe(
    //   "SQLPage .sql file with constants for the project paths, artifacts, etc.",
    // ),
    resourcesAutoJson: z.string().describe(
      "JSON text file listing of all resources (with @spry.* annotations)",
    ),
    routesAutoJson: z.string().describe(
      "JSON text file with full routes resolved from @route.* annotations",
    ),
    routesTreeAutoTxt: z.string().describe(
      "Simple text file showing route tree resolved from @route.* annotations",
    ),
    edgesAutoJson: z.string().describe(
      "JSON text file with parent/child edges resolved from @route.* annotations",
    ),
  }),
});

export const sqlPageAssemblerProjectPropsSchema =
  typicalAssemblerProjectPropsSchema
    .extend({
      projectPaths: typicalAssemblerProjectPropsSchema.shape.projectPaths
        .extend(sqlPageProjectPathsSchema.shape),
      projectArtifacts: typicalAssemblerProjectPropsSchema.shape
        .projectArtifacts.extend(sqlPageProjectArtifactsSchema.shape),
    });

// Common catalog fields present for all resources discovered in the catalog
export const resourceCatalogFields = z.object({
  path: z.string().describe("Filesystem path relative to project root"),
  basename: z.string().describe("Base file name (no directories)"),
  extension: z.string().describe("Primary extension without dot"),
  // Some entries include multiple extensions (e.g., [".ddl","sql"] or [".json","ts"])
  extensions: z.array(z.string()).optional()
    .describe("Additional or compound extensions, order preserved"),
  autoMaterializeTo: z.string().optional()
    .describe("If set, where this resource auto-materializes its artifact"),
  srcCodeLanguage: z.string().optional()
    .describe(
      "Source language classification (e.g., 'sql', 'typescript', 'shell')",
    ),
  route: routeAnnSchema.optional(),
}).strict();

/**
 * Extends the base Resource schema with catalog metadata.
 * This keeps all nature-specific constraints from resourceSchema
 * (e.g., sqlImpact requirements) and adds catalog fields common to files.
 */
export const resourceCatalogEntry = z.intersection(
  resourceSchema,
  resourceCatalogFields,
);

export type ResourceCatalogEntry = z.infer<typeof resourceCatalogEntry>;

// Collection type for resources.auto.json catalogs
export const resourcesCatalogListSchema = z.array(resourceCatalogEntry);
export type ResourcesCatalog = z.infer<typeof resourcesCatalogListSchema>;

export class SqlPageAssembler<R extends Resource> extends Assembler<R> {
  readonly projectFsDriver = localDriver();
  readonly projectHomeFs: ReactiveFs<Any>;
  readonly projectSrcFs: ReactiveFs<Any>;
  readonly spryDropInsHomeFs: ReactiveFs<Any>;
  readonly spryDropInsAutoFs: ReactiveFs<Any>;
  readonly spryDropInsResourceCatalogEntryFs: ReactiveFs<Any>;

  constructor(
    projectId: string,
    moduleHome: string, // import.meta.resolve('./') from module
    assemblerBuses: AssemblerBusesInit<R>,
    readonly stdlibSymlinkDest: string,
    init: { sideAffectsAllowed: SideAffects; cleaningRequested?: boolean },
  ) {
    super(projectId, moduleHome, assemblerBuses, init);

    const resourceSupplierIdentity = ["PROJECT_HOME"] as const;
    type ResourceSupplierIdentity = typeof resourceSupplierIdentity[number];

    this.withSuppliers(fsFilesContributor<R, ResourceSupplierIdentity>({
      identity: "PROJECT_HOME",
      root: this.projectPaths().projectSrcHome,
      walkOptions: {
        includeDirs: false,
        includeFiles: true,
        includeSymlinks: false,
        followSymlinks: true, // important for "src/spry"
        canonicalize: true,
      },
      relFsPath: (path) => this.relToPrjOrStd(path),
      webPath: (path) => this.relToPrjOrStd(path).replace(/^.*src\//, ""),
    }));

    const paths = this.projectPaths();
    this.projectHomeFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.projectHome as RootLiteral,
    ));
    this.projectSrcFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.projectSrcHome as RootLiteral,
    ));
    this.spryDropInsHomeFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.spryDropIn.fsHome as RootLiteral,
    ));
    this.spryDropInsAutoFs = reactiveFs(rootFs(
      this.projectFsDriver,
      paths.spryDropIn.fsAuto as RootLiteral,
    ));
    this.spryDropInsResourceCatalogEntryFs = reactiveFs(rootFs(
      this.projectFsDriver,
      join(paths.spryDropIn.fsAuto, "resource") as RootLiteral,
    ));

    this.resourceBus.on("assembler:state:mutated", async (ev) => {
      if (
        ev.current.step === "final" &&
        ev.assemblerState.init.sideAffectsAllowed.materialize
      ) {
        try {
          await Deno.mkdir(paths.projectSrcHome, { recursive: true });
          await Deno.mkdir(paths.spryDropIn.fsHome, {
            recursive: true,
          });
          await Deno.mkdir(paths.spryDropIn.fsAuto, {
            recursive: true,
          });
        } catch (err) {
          // TODO: create an event from this and report to the bus
          console.error(err);
        }

        await this.dropInArtifacts(ev.current.materialized);
      }
    });
  }

  cleaner() {
    const paths = this.projectPaths();
    return cleaner({
      removeDirs: [{
        absFsPath: paths.spryDropIn.fsAuto,
        recursive: true,
      }, {
        absFsPath: paths.spryDropIn.fsHome,
        onlyIfEmpty: true,
      }],
    });
  }

  relToPrjOrStd(supplied: string) {
    const result = relative(this.projectPaths().projectHome, supplied);
    if (result.startsWith(this.stdlibSymlinkDest)) {
      return relative(
        Deno.cwd(), // assume that CWD is the project home
        join("src", "spry", relative(this.stdlibSymlinkDest, supplied)),
      );
    }
    return result;
  }

  webPathOf(supplied: string) {
    const result = relative(this.projectPaths().projectHome, supplied);
    if (result.startsWith(this.stdlibSymlinkDest)) {
      return relative(
        Deno.cwd(), // assume that CWD is the project home
        join("spry", relative(this.stdlibSymlinkDest, supplied)),
      );
    }
    return relative(this.projectPaths().projectSrcHome, supplied);
  }

  override projectStatePropertiesBag() {
    return propertiesBag(sqlPageAssemblerProjectPropsSchema);
  }

  override projectPaths(
    projectHome = this.moduleHome.startsWith("file:")
      ? fromFileUrl(this.moduleHome)
      : this.moduleHome,
  ) {
    const projectSrcHome = resolve(projectHome, "src");
    const absPathToSpryLocal = join(projectSrcHome, "spry");
    const relPathToSpryLocal = relative(Deno.cwd(), absPathToSpryLocal);

    // Spry is usually symlinked and Deno.watchFs doesn't follow symlinks
    // so we watch the physical Spry because the symlink won't be watched
    // even though it's under the "src".
    const devWatchRoots = [
      relative(Deno.cwd(), projectSrcHome),
      relative(Deno.cwd(), this.stdlibSymlinkDest),
    ];
    return {
      ...super.projectPaths(projectHome),
      projectSqlDropIn: {
        fsHome: resolve(projectSrcHome, "sql.d"),
        fsHeadHome: resolve(projectSrcHome, "sql.d", "head"),
        fsTailHome: resolve(projectSrcHome, "sql.d", "tail"),
      },
      spryDropIn: {
        fsHome: resolve(projectSrcHome, "spry.d"),
        fsAuto: resolve(projectSrcHome, "spry.d", "auto"),
        webHome: join("spry.d"),
        webAuto: join("spry.d", "auto"),
      },
      spryStd: {
        fsHomeFromSymlink: relative(
          dirname(absPathToSpryLocal),
          this.stdlibSymlinkDest,
        ),
        fsHomeAbs: absPathToSpryLocal,
        fsHomeRelToProject: relPathToSpryLocal,
        sqlDropIn: {
          fsHome: resolve(relPathToSpryLocal, "sql.d"),
          fsHeadHome: resolve(relPathToSpryLocal, "sql.d", "head"),
          fsTailHome: resolve(relPathToSpryLocal, "sql.d", "tail"),
        },
      },
      sqlPage: {
        fsConfDirHome: join(projectHome, "sqlpage"),
      },
      devWatchRoots,
    } satisfies z.infer<typeof sqlPageProjectPathsSchema>;
  }

  protected resourcesCatalog(rc: ResourcesCollection<R>) {
    return (rc.resources.map((r) => {
      // TODO: convert this to Zod and prepare a JSON Schema
      // deno-lint-ignore no-explicit-any
      let entry: Record<string, any> = {
        nature: r.nature,
        path: isWebPathSupplier(r) ? r.webPath : undefined,
        isSystemGenerated: r.isSystemGenerated,
      };
      if (isFsFileResource(r)) {
        entry = {
          ...entry,
          isParsedSuccessfully: r.isParsedSuccessfully,
          basename: r.extensions.basename,
          extension: r.extensions.terminal,
        };
        if (r.extensions.extensions.length > 1) {
          entry.extensions = r.extensions.extensions;
        }
        const isAM = r.extensions.autoMaterializable();
        if (isAM) {
          entry.autoMaterializeTo = this.webPathOf(isAM);
        }
      }
      if (isFsSrcCodeFileSupplier(r)) {
        entry = {
          ...entry,
          srcCodeLanguage: r.srcCodeLanguage.id,
        };
      }
      if (isRouteSupplier(r)) {
        entry = {
          ...entry,
          route: r.route.annotated,
        };
      }
      return entry;
    }) as unknown as ResourcesCatalog).filter((r) =>
      r.path.indexOf(".auto.") > 0 ? false : true
    );
  }

  protected async dropInArtifacts(rc: ResourcesCollection<R>) {
    // don't store absFsPath because it will be different across systems
    // making it harder to store in Git (because it will show diffs)
    const cwd = Deno.cwd();
    const withRelativeToCWD = (_: readonly string[], value: unknown) =>
      relative(cwd, String(value));
    const mutateNonIdempotent = jsonStringifyReplacers([
      { query: "absFsPath", action: "omit" },
      { query: "supplier.root", action: "replace", with: withRelativeToCWD },
      { query: "walkEntry.path", action: "replace", with: withRelativeToCWD },
    ]);

    const pp = this.projectPaths();

    for await (const rcr of rc.resources) {
      if (isWebPathSupplier(rcr)) {
        const path = rel(rcr.webPath);
        // reactive-fs local-fs write automatically creates directories
        await this.spryDropInsResourceCatalogEntryFs.write(
          `${path}.auto.json` as RelCanonical,
          JSON.stringify(rcr, mutateNonIdempotent, 2),
          { overwrite: true },
        );
      }
    }

    const { absPath: resourcesAutoJson } = await this.spryDropInsAutoFs.write(
      rel("resources.auto.json"),
      JSON.stringify(this.resourcesCatalog(rc), null, 2),
      { overwrite: true },
    );

    const routes = new Routes(
      rc.resources.filter(isRouteSupplier)
        .map((rs) =>
          isRouteSupplier(rs) ? rs.route.annotated : {} as AnnotatedRoute
        ),
    );
    const { serializers, breadcrumbs, edges } = await routes.populate();

    const { absPath: routesAutoJson } = await this.spryDropInsAutoFs.write(
      rel("routes.auto.json"),
      serializers.jsonText({ space: 2 }),
      { overwrite: true },
    );

    const { absPath: routesTreeAutoTxt } = await this.spryDropInsAutoFs.write(
      rel("routes-tree.auto.txt"),
      serializers.asciiTreeText(),
      { overwrite: true },
    );

    for await (const [webPath, bc] of Object.entries(breadcrumbs)) {
      const path = rel(`breadcrumbs/${webPath}`);
      await this.spryDropInsAutoFs.write(
        `${path}.auto.json` as RelCanonical,
        JSON.stringify(bc, null, 2),
        { overwrite: true },
      );
    }

    const { absPath: edgesAutoJson } = await this.spryDropInsAutoFs.write(
      rel("edges.auto.json"),
      JSON.stringify(edges, null, 2),
      { overwrite: true },
    );

    const bag = this.projectStatePropertiesBag();
    const artifacts: z.infer<typeof sqlPageProjectArtifactsSchema> = {
      materialized: {
        resourcesAutoJson: relative(
          pp.projectSrcHome,
          resourcesAutoJson,
        ),
        routesAutoJson: relative(pp.projectSrcHome, routesAutoJson),
        routesTreeAutoTxt: relative(
          pp.projectSrcHome,
          routesTreeAutoTxt,
        ),
        edgesAutoJson: relative(pp.projectSrcHome, edgesAutoJson),
      },
    };

    const props = {
      projectId: this.projectId,
      projectPaths: this.projectPaths(),
      projectArtifacts: artifacts,
    };
    // validate + cache in the bag (Zod coerces/strips unknowns if any)
    bag.set("projectId", props.projectId);
    bag.set("projectPaths", props.projectPaths);
    bag.set("projectArtifacts", props.projectArtifacts);

    const f = flatten(bag);
    const govnSql: string[] = [];
    // deno-fmt-ignore
    for (const r of f.entries(props)) {
      const cmt = `-- [${r.valueHint}] ${r.comment ?? "(TODO: supply comment)"}`;
      govnSql.push(`${cmt}\nSET ${toSnakeCase(r.name)} = ${literalSQL(r.value)};`);
    }

    const { path } = await this.spryDropInsAutoFs.write(
      rel("project-govn.auto.sql"),
      govnSql.join("\n\n"),
      { overwrite: true },
    );
    console.log(path);
  }
}
