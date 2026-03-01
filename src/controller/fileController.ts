import { Context } from 'hono'
import fileService from '../service/fileService'

/**
 * 列出目录下的文件
 * GET /file/list?path=src/resource&pattern=*.sql
 */
async function list(c: Context) {
  const path = c.req.query('path') || ''
  const pattern = c.req.query('pattern') || '*'

  try {
    const files = await fileService.listFiles(path, pattern)
    return c.json({ success: true, path, pattern, files })
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500)
  }
}

/**
 * 读取文件内容
 * GET /file/read?path=src/resource/migrate_0001.sql
 */
async function read(c: Context) {
  const path = c.req.query('path')

  if (!path) {
    return c.json({ success: false, error: 'path parameter is required' }, 400)
  }

  try {
    const content = await fileService.readFile(path)
    return c.json({ success: true, path, content })
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500)
  }
}

export { list, read }
