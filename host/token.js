/** Per-process token shared by the list routes and the chat routes. */
import { randomBytes } from 'node:crypto'

export const TOKEN = randomBytes(24).toString('hex')
