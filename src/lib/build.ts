import path from 'path'
import glob from 'fast-glob'
import postcss from 'postcss'
import process from 'process'
import * as fse from 'fs-extra'
import * as createDebugLogger from 'debug'

import { buildPages } from './pages'

export const debug = createDebugLogger.default('dhow:build')

export type BuildOptions = {
    initial: boolean,
    changes: { type: string, path: string }[],
}

const copyPublic = async (toPath: string, options: BuildOptions) => {
    const origin = path.join(process.cwd(), 'public')

    if (options.initial) {
        return await fse.copy(origin, toPath)
    }

    // Assume that content was already copied over so only do what's necessary
    for (const change of options.changes) {
        if (!change.path.startsWith(origin)) {
            continue
        }

        const destination = path.join(change.path.slice(origin.length))

        if (change.type === 'unlink') {
            debug('deleting %o as part of change %o', destination, change)

            await fse.remove(destination)
        }

        if (change.type === 'change' || change.type === 'add') {
            debug('copying %o to %o as part of change of type %o', destination,
                change.path, change.type)

            await fse.copy(change.path, destination)
        }
    }
}

const processCSS = async (directory: string, options: BuildOptions) => {
    let plugins = []

    try {
        plugins = require(path.resolve('postcss.config.js')).plugins
    } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') {
            throw err
        }
    }

    const processor = postcss(plugins)
    const cssFiles = (await glob(path.join(directory, '**/*.css')))

    for (const cssFile of cssFiles) {
        const filePath = path.resolve(cssFile)

        const relevantChanges = options.changes.filter((c) => (
            // We don't care about unlinked files since they were handled in a 
            // previous step
            c.path === filePath && c.type !== 'unlink'
        ))

        if (!options.initial) {
            debug('relevant changes for %o are %o', cssFile, relevantChanges)
        }

        // Skip this file if this is not the initial build and there were no
        // relevant changes
        if (!options.initial && !relevantChanges.length) {
            debug('skipping %o', cssFile)

            continue
        }

        const processed = await processor.process(await fse.readFile(filePath), {
            // For source-maps, in case we ever start generating them
            from: filePath
        })

        await fse.writeFile(filePath, processed.css)
    }
}

const build = async (from: string, to: string, options: BuildOptions = {
    initial: true, changes: []
}) => {
    const fromPath = path.resolve(from)
    const toPath = path.resolve(to)

    if (fromPath === toPath) {
        throw new Error('The input and output directories must not be the same.')
    }

    if (options.initial) {
        // Ensure `toPath` points to an empty directory
        await fse.remove(toPath);
        await fse.ensureDir(toPath);

        debug('performing initial build, cleaned %o', toPath)
    } else {
        debug('performing incremental build based on %o', options.changes)
    }

    // Build pages from `from` to `to`
    await buildPages(fromPath, toPath, options)
    debug('built pages')

    await copyPublic(toPath, options)
    debug('copied public directory')

    // Process CSS inside `to`
    await processCSS(toPath, options)
    debug('processed css')
}

export default build
