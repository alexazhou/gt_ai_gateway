// 类型声明：允许 import .sql 文件作为字符串（wrangler Text 模块）
declare module "*.sql" {
    const content: string;
    export default content;
}
