import { ormService } from './service/ormService'
import { registerFile } from './service/fileService'
import migrate_0001 from './resource/migrate_0001.sql'
import migrate_0002 from './resource/migrate_0002.sql'
import migrate_0003 from './resource/migrate_0003.sql'
import app from './routes'

// 注册资源文件
registerFile([
  { path: 'src/resource/migrate_0001.sql', content: migrate_0001 },
  { path: 'src/resource/migrate_0002.sql', content: migrate_0002 },
  { path: 'src/resource/migrate_0003.sql', content: migrate_0003 },
])

// 初始化云端配置
await ormService.init({ mode: 'cloud' })

export default app
