// 这些文件由 wrangler 按文本模块引进来，默认导出是文件内容。
declare module "*.html" {
  const content: string;
  export default content;
}
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.js" {
  const content: string;
  export default content;
}
declare module "*.svg" {
  const content: string;
  export default content;
}
