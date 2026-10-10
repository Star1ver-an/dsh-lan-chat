/** Read-only extraction of the installed official SDK for building/testing. */
import {extractAll} from '@electron/asar'
import {resolve,join} from 'node:path'
import {existsSync,mkdirSync} from 'node:fs'
const archive=process.argv[2] ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/DeepSeek Harness/resources/app.asar')
if(!existsSync(archive))throw new Error('Pass the path of the official Desktop resources/app.asar')
const destination=resolve('.runtime');mkdirSync(destination,{recursive:true})
extractAll(archive,destination)
console.log('SDK extracted into .runtime; installed application was not modified.')
