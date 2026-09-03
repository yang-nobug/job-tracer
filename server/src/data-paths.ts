import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredDataDir = process.env.JOB_TRACER_DATA_DIR?.trim()

export const DATA_DIR = configuredDataDir ? path.resolve(configuredDataDir) : path.resolve(__dirname, '../../data')
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads')
export const REVIEWS_DIR = path.join(DATA_DIR, 'reviews')
export const KNOWLEDGE_IMAGES_DIR = path.join(DATA_DIR, 'knowledge_images')
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings')
export const APPLICATION_MATERIALS_DIR = path.join(DATA_DIR, 'application_materials')
