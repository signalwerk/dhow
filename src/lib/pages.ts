import path from 'path'
import glob from 'fast-glob'
import * as fse from 'fs-extra'
import * as esbuild from 'esbuild'

import { debug, BuildOptions } from './build'

import { head } from './head'
import { createElement, Component, Props } from './jsx-runtime'

const DefaultDocument = (
    createElement('html', { lang: 'en' },
        createElement('head', {},
            createElement('meta', { charset: 'utf-8' })
        ),
        createElement('body', {})
    )
)

const DefaultWrapper = (props: Props = {}) => (
    createElement(props.Component, props.pageProps)
)

const buildJsFile = async (fromFile: string, toFile: string) => {
    return esbuild.build({
        entryPoints: [ fromFile ],
        outfile: toFile,

        // Make sure we can run the built files later
        format: 'cjs',
        platform: 'node',
        // ...without depending on being able to import stuff at runtime
        bundle: true,

        // Support JSX
        loader: { '.js': 'jsx' },
        jsxFactory: 'Dhow.createElement',
        jsxFragment: 'Dhow.Fragment',
        // ...and inject the relevant import into every file
        external: [ 'dhow' ],
        inject: [ path.join(__dirname, '/import-shim.js') ],
    })
}

type Page = {
    default: Component,
    getPaths?: () => Promise<string[]>,
    getProps: (path?: string) => Promise<Props>,
}

const readPage = (filePath: string) => {
    // Ensure that code is always re-run since it might have changed since the 
    // last time this was called
    if (require.cache[filePath]) {
        delete require.cache[filePath]
    }

    try {
        const pageModule = require(filePath)
        const page: Page = {
            default: pageModule.default,
            getPaths: pageModule.getPaths || undefined,
            getProps: pageModule.getProps || (async () => ({})),
        }

        if (typeof page.default !== 'function') {
            throw new Error('does not `export default` a function')
        }

        if (typeof page.getProps !== 'function') {
            throw new Error('has an invalid `getProps` export')
        }

        if (page.getPaths && typeof page.getPaths !== 'function') {
            throw new Error('has an invalid `getPaths` export')
        }

        page.getProps = page.getProps || (() => {})

        return page
    } catch (err) {
        throw new Error(`Malformed page (${filePath}): ${err.message}`)
    }
}

const readComponentLike = (filePath: string) => {
    try {
        const componentModule = require(filePath)
        const component: Component = componentModule.default

        if (typeof component !== 'function') {
            throw new Error('default export is not a function')
        }

        return component
    } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
            return null
        }

        throw new Error(`Malformed component (${filePath}): ${err.message}`)
    }
}

const getDocument = (pagesPath: string) => {
    const custom = readComponentLike(path.join(pagesPath, '_document.js'))

    if (custom) {
        return custom()
    }

    return DefaultDocument
}

const getWrapper = (pagesPath: string) => {
    const custom = readComponentLike(path.join(pagesPath, '_app.js'))

    if (custom) {
        return custom
    }

    return DefaultWrapper
}

const getLocalDependencies = async (filePath: string) => {
    const content = await fse.readFile(filePath, 'utf8')
    const lines = content.split('\n')
    const dependencies: string[] = []

    for (const line of lines) {
        if (!line.trim().startsWith('import')) {
            continue
        }

        const normalizedLine = line.replace('"', '\'').replace('`', '\'')
        const dependency = normalizedLine.substring(
            normalizedLine.indexOf('\'') + 1,
            normalizedLine.lastIndexOf('\''),
        )

        if (dependency[0] !== '.') {
            continue
        }

        const parsedFilePath = path.parse(filePath)

        dependencies.push(path.resolve(
            parsedFilePath.dir,
            dependency.endsWith('.js') ? dependency : dependency + '.js'
        ))
    }

    return dependencies
}

const pagesCache: { [path: string]: {
    routePaths: string[],
    localDependencies: string[],
} } = {}

export const buildPages = async (
    fromPath: string, toPath: string, options: BuildOptions
) => {
    debug(pagesCache)

    // Handle deletions of pages
    for (const change of options.changes) {
        if (change.type !== 'unlink' || !change.path.startsWith(fromPath)) {
            continue
        }

        const cachedPaths = pagesCache[change.path].routePaths

        if (!cachedPaths.length) {
            debug('page path cache did not contain expected path %o', change.path)

            continue
        }

        for (const cachedPath of cachedPaths) {
            await fse.remove(cachedPath)

            debug('removed cached path %o', cachedPath)
        }
    }

    // Trigger a page rebuild if a dependency of the page changed
    for (const change of options.changes) {
        for (const pagePath of Object.keys(pagesCache)) {
            if (pagesCache[pagePath]?.localDependencies.includes(change.path)) {
                options.changes.push({ type: 'change', path: pagePath })
            }
        }
    }

    const stagingPath = path.join(toPath, '.staging')
    await fse.ensureDir(stagingPath)

    // Build all .js files (pages) to staging (JSX -> regular JS)
    const jsFilePaths = options.initial ? (
        await glob(path.join(fromPath, '**/*.js'))
    ) : (
        options.changes
            .filter((c) => c.type !== 'unlink' && c.path.startsWith(fromPath))
            .map((change) => change.path)
    )

    if (!jsFilePaths.length) {
        debug('skipping page building since there are no new files to build')

        return
    } else {
        debug('building js files %o', jsFilePaths)
    }

    debug('getting local dependencies of js files')

    for (const filePath of jsFilePaths) {
        if (!pagesCache[filePath]) {
            pagesCache[filePath] = {
                routePaths: [], // This will be set later on
                localDependencies: [],
            }
        }

        pagesCache[filePath].localDependencies =
            await getLocalDependencies(filePath)
    }

    debug('transpiling js files to %o', stagingPath)

    await Promise.all(
        jsFilePaths.map((filePath) => buildJsFile(
            filePath,
            path.join(stagingPath, filePath.slice(fromPath.length)),
        ))
    )

    // Set up the document (VNode tree) into which built html will be inserted
    const document = getDocument(stagingPath)
    const documentEntry = document.find({ id: 'dhow' })
        || document.find({ type: 'body' })
    const documentHead = document.find({ type: 'head' })

    if (!documentEntry) {
        throw new Error('Invalid document, no entry point found.')
    }

    if (!documentHead) {
        throw new Error('Invalid document, no head found.')
    }

    // Get the component which will wrap all pages 
    const Wrapper = getWrapper(stagingPath)

    // Get the paths to all pages (all .js files in staging)
    const pagePaths = await glob(path.join(stagingPath, '**/*.js'))

    debug('building pages at the paths %o', pagePaths)

    for (const pagePath of pagePaths) {
        const parsedPagePath = path.parse(pagePath)

        if ([ '_app.js', '_document.js' ].includes(parsedPagePath.name)) {
            continue
        }

        const pageDir = parsedPagePath.dir.slice(stagingPath.length)

        const page = readPage(pagePath)

        // Compute all routes (all folders where a .html file will eventually 
        // be generated to
        const routePaths = page.getPaths ? (
            (await page.getPaths()).map((p) => path.join(pageDir, p))
        ) : (
            [ parsedPagePath.name === 'index' ? pageDir : parsedPagePath.name ]
        )

        // The `cacheKey` is really just the path of the original .js file
        const cacheKey = path.join(fromPath, pagePath.slice(stagingPath.length))
        if (!pagesCache[cacheKey]) {
            pagesCache[cacheKey] = { routePaths: [], localDependencies: [] }
        }

        for (const routePath of routePaths) {
            // Strip the previously prepended pageDir from the routePath since 
            // getProps expects the values that were returned from getPaths
            const props = await page.getProps(routePath.slice(pageDir.length))
            const html = createElement(Wrapper, {
                Component: page.default, pageProps: props
            }).toString()

            documentEntry.children = [ html ]

            if (head.contents) {
                documentHead.children.push(...head.contents)

                head.contents = []
            }

            const htmlPath = path.join(toPath, routePath, 'index.html')
            await fse.outputFile(htmlPath, document.toString())

            if (!pagesCache[cacheKey].routePaths.includes(htmlPath)) {
                pagesCache[cacheKey].routePaths.push(htmlPath)
            }
        }
    }

    await fse.remove(stagingPath)
}
