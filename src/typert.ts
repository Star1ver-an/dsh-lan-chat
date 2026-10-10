import { TYPERT as chat } from './generated/chat.host.js'
import { descriptors } from './update/remote.ts'
export const TYPERT = { ...chat, invocations: [...chat.invocations, ...descriptors] }
