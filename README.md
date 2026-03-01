ReadMe

# 项目命令
```
npm install
npm run dev
```

```
npm run deploy
```

# 项目初始化

## 初始化 DB
```
wrangler d1 execute serverless_ai_gateway --local --file=src/resource/migrate_0001.sql
```

## 查看已有数据表
```
wrangler d1 execute serverless_ai_gateway --local --command "select * from sqlite_master"
```

## 删除数据表
```
wrangler d1 execute serverless_ai_gateway --local --command "drop table user"
```


