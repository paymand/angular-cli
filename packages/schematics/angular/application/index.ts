/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  JsonAstObject,
  JsonObject,
  JsonParseMode,
  JsonValue,
  join,
  normalize,
  parseJsonAst,
  strings,
} from '@angular-devkit/core';
import {
  MergeStrategy,
  Rule,
  SchematicContext,
  SchematicsException,
  Tree,
  apply,
  applyTemplates,
  chain,
  filter,
  mergeWith,
  move,
  noop,
  schematic,
  url,
} from '@angular-devkit/schematics';
import { NodePackageInstallTask } from '@angular-devkit/schematics/tasks';
import { Schema as ComponentOptions } from '../component/schema';
import { Schema as E2eOptions } from '../e2e/schema';
import { NodeDependencyType, addPackageJsonDependency } from '../utility/dependencies';
import { JSONFile } from '../utility/json-file';
import { latestVersions } from '../utility/latest-versions';
import { applyLintFix } from '../utility/lint-fix';
import { relativePathToWorkspaceRoot } from '../utility/paths';
import { addTsConfigProjectReferences, verifyBaseTsConfigExists } from '../utility/tsconfig';
import { validateProjectName } from '../utility/validation';
import { getWorkspace, updateWorkspace } from '../utility/workspace';
import { Builders, ProjectType } from '../utility/workspace-models';
import { Schema as ApplicationOptions, Style } from './schema';

function addDependenciesToPackageJson(options: ApplicationOptions) {
  return (host: Tree, context: SchematicContext) => {
    [
      {
        type: NodeDependencyType.Dev,
        name: '@angular/compiler-cli',
        version: latestVersions.Angular,
      },
      {
        type: NodeDependencyType.Dev,
        name: '@angular-devkit/build-angular',
        version: latestVersions.DevkitBuildAngular,
      },
      {
        type: NodeDependencyType.Dev,
        name: 'typescript',
        version: latestVersions.TypeScript,
      },
    ].forEach(dependency => addPackageJsonDependency(host, dependency));

    if (!options.skipInstall) {
      context.addTask(new NodePackageInstallTask());
    }

    return host;
  };
}

function readTsLintConfig(host: Tree, path: string): JsonAstObject {
  const buffer = host.read(path);
  if (!buffer) {
    throw new SchematicsException(`Could not read ${path}.`);
  }

  const config = parseJsonAst(buffer.toString(), JsonParseMode.Loose);
  if (config.kind !== 'object') {
    throw new SchematicsException(`Invalid ${path}. Was expecting an object.`);
  }

  return config;
}

/**
 * Merges the application tslint.json with the workspace tslint.json
 * when the application being created is a root application
 *
 * @param {Tree} parentHost The root host of the schematic
 */
function mergeWithRootTsLint(parentHost: Tree) {
  return (host: Tree) => {
    const tsLintPath = '/tslint.json';
    if (!host.exists(tsLintPath)) {
      return;
    }

    const rootTslintConfig = new JSONFile(parentHost, tsLintPath);
    const appTslintConfig = new JSONFile(host, tsLintPath);

    for (const [pKey, pValue] of Object.entries(rootTslintConfig.get([]) as Record<string, JsonValue>)) {
      if (typeof pValue !== 'object' || Array.isArray(pValue)) {
        appTslintConfig.modify([pKey], pValue);
        continue;
      }

      for (const [key, value] of Object.entries(rootTslintConfig.get([pKey]) as Record<string, JsonObject>)) {
        appTslintConfig.modify([pKey, key], value);
      }
    }
  };
}

function addAppToWorkspaceFile(options: ApplicationOptions, appDir: string): Rule {
  let projectRoot = appDir;
  if (projectRoot) {
    projectRoot += '/';
  }

  const schematics: JsonObject = {};

  if (options.inlineTemplate
    || options.inlineStyle
    || options.minimal
    || options.style !== Style.Css) {
    const componentSchematicsOptions: JsonObject = {};
    if (options.inlineTemplate || options.minimal) {
      componentSchematicsOptions.inlineTemplate = true;
    }
    if (options.inlineStyle || options.minimal) {
      componentSchematicsOptions.inlineStyle = true;
    }
    if (options.style && options.style !== Style.Css) {
      componentSchematicsOptions.style = options.style;
    }

    schematics['@schematics/angular:component'] = componentSchematicsOptions;
  }

  if (options.skipTests || options.minimal) {
    ['class', 'component', 'directive', 'guard', 'interceptor', 'module', 'pipe', 'service'].forEach((type) => {
      if (!(`@schematics/angular:${type}` in schematics)) {
        schematics[`@schematics/angular:${type}`] = {};
      }
      (schematics[`@schematics/angular:${type}`] as JsonObject).skipTests = true;
    });
  }

  if (options.strict) {
    if (!('@schematics/angular:application' in schematics)) {
      schematics['@schematics/angular:application'] = {};
    }

    (schematics['@schematics/angular:application'] as JsonObject).strict = true;
  }

  const sourceRoot = join(normalize(projectRoot), 'src');
  let budgets = [];
  if (options.strict) {
    budgets = [
      {
        type: 'initial',
        maximumWarning: '500kb',
        maximumError: '1mb',
      },
      {
        type: 'anyComponentStyle',
        maximumWarning: '2kb',
        maximumError: '4kb',
      },
    ];
  } else {
    budgets = [
      {
        type: 'initial',
        maximumWarning: '2mb',
        maximumError: '5mb',
      },
      {
        type: 'anyComponentStyle',
        maximumWarning: '6kb',
        maximumError: '10kb',
      },
    ];
  }

  const project = {
    root: normalize(projectRoot),
    sourceRoot,
    projectType: ProjectType.Application,
    prefix: options.prefix || 'app',
    schematics,
    targets: {
      build: {
        builder: Builders.Browser,
        options: {
          outputPath: `dist/${options.name}`,
          index: `${sourceRoot}/index.html`,
          main: `${sourceRoot}/main.ts`,
          polyfills: `${sourceRoot}/polyfills.ts`,
          tsConfig: `${projectRoot}tsconfig.app.json`,
          aot: true,
          assets: [
            `${sourceRoot}/favicon.ico`,
            `${sourceRoot}/assets`,
          ],
          styles: [
            `${sourceRoot}/styles.${options.style}`,
          ],
          scripts: [],
        },
        configurations: {
          production: {
            fileReplacements: [{
              replace: `${sourceRoot}/environments/environment.ts`,
              with: `${sourceRoot}/environments/environment.prod.ts`,
            }],
            optimization: true,
            outputHashing: 'all',
            sourceMap: false,
            extractCss: true,
            namedChunks: false,
            extractLicenses: true,
            vendorChunk: false,
            buildOptimizer: true,
            budgets,
          },
        },
      },
      serve: {
        builder: Builders.DevServer,
        options: {
          browserTarget: `${options.name}:build`,
        },
        configurations: {
          production: {
            browserTarget: `${options.name}:build:production`,
          },
        },
      },
      'extract-i18n': {
        builder: Builders.ExtractI18n,
        options: {
          browserTarget: `${options.name}:build`,
        },
      },
      test: options.minimal ? undefined : {
        builder: Builders.Karma,
        options: {
          main: `${sourceRoot}/test.ts`,
          polyfills: `${sourceRoot}/polyfills.ts`,
          tsConfig: `${projectRoot}tsconfig.spec.json`,
          karmaConfig: `${projectRoot}karma.conf.js`,
          assets: [
            `${sourceRoot}/favicon.ico`,
            `${sourceRoot}/assets`,
          ],
          styles: [
            `${sourceRoot}/styles.${options.style}`,
          ],
          scripts: [],
        },
      },
      lint: options.minimal ? undefined : {
        builder: Builders.TsLint,
        options: {
          tsConfig: [
            `${projectRoot}tsconfig.app.json`,
            `${projectRoot}tsconfig.spec.json`,
          ],
          exclude: [
            '**/node_modules/**',
          ],
        },
      },
    },
  };

  return updateWorkspace(workspace => {
    if (workspace.projects.size === 0) {
      workspace.extensions.defaultProject = options.name;
    }

    workspace.projects.add({
      name: options.name,
      ...project,
    });
  });
}
function minimalPathFilter(path: string): boolean {
  const toRemoveList = /(test.ts|tsconfig.spec.json|karma.conf.js|tslint.json).template$/;

  return !toRemoveList.test(path);
}

export default function (options: ApplicationOptions): Rule {
  return async (host: Tree) => {
    if (!options.name) {
      throw new SchematicsException(`Invalid options, "name" is required.`);
    }

    validateProjectName(options.name);
    verifyBaseTsConfigExists(host);

    const appRootSelector = `${options.prefix}-root`;
    const componentOptions: Partial<ComponentOptions> = !options.minimal ?
      {
        inlineStyle: options.inlineStyle,
        inlineTemplate: options.inlineTemplate,
        skipTests: options.skipTests,
        style: options.style,
        viewEncapsulation: options.viewEncapsulation,
      } :
      {
        inlineStyle: true,
        inlineTemplate: true,
        skipTests: true,
        style: options.style,
      };

    const workspace = await getWorkspace(host);
    const newProjectRoot = workspace.extensions.newProjectRoot as (string | undefined) || '';
    const isRootApp = options.projectRoot !== undefined;
    const appDir = isRootApp
      ? normalize(options.projectRoot || '')
      : join(normalize(newProjectRoot), options.name);
    const sourceDir = `${appDir}/src/app`;

    const e2eOptions: E2eOptions = {
      relatedAppName: options.name,
      rootSelector: appRootSelector,
    };

    return chain([
      addAppToWorkspaceFile(options, appDir),
      mergeWith(
        apply(url('./files'), [
          options.minimal ? filter(minimalPathFilter) : noop(),
          applyTemplates({
            utils: strings,
            ...options,
            relativePathToWorkspaceRoot: relativePathToWorkspaceRoot(appDir),
            appName: options.name,
            isRootApp,
          }),
          isRootApp ? mergeWithRootTsLint(host) : noop(),
          move(appDir),
        ]), MergeStrategy.Overwrite),
      schematic('module', {
        name: 'app',
        commonModule: false,
        flat: true,
        routing: options.routing,
        routingScope: 'Root',
        path: sourceDir,
        project: options.name,
      }),
      schematic('component', {
        name: 'app',
        selector: appRootSelector,
        flat: true,
        path: sourceDir,
        skipImport: true,
        project: options.name,
        ...componentOptions,
      }),
      mergeWith(
        apply(url('./other-files'), [
          options.strict
            ? noop()
            : filter(path => path !== '/package.json.template'),
          componentOptions.inlineTemplate
            ? filter(path => !path.endsWith('.html.template'))
            : noop(),
          componentOptions.skipTests
            ? filter(path => !path.endsWith('.spec.ts.template'))
            : noop(),
          applyTemplates({
            utils: strings,
            ...options,
            selector: appRootSelector,
            ...componentOptions,
          }),
          move(sourceDir),
        ]), MergeStrategy.Overwrite),
      addTsConfigProjectReferences([
        join(appDir, 'tsconfig.app.json'),
        join(appDir, 'tsconfig.spec.json'),
      ]),
      options.minimal ? noop() : schematic('e2e', e2eOptions),
      options.skipPackageJson ? noop() : addDependenciesToPackageJson(options),
      options.lintFix ? applyLintFix(appDir) : noop(),
    ]);
  };
}
