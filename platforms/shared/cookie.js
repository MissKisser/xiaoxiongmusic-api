/**
 * 平台 cookie 解析
 *
 * 上游 server.js 在分发请求前会把 `query.cookie` / `body.cookie` 里的字符串
 * 按网易的 `cookieToJson` 预先解析一次。QQ 音乐与酷狗的 cookie 字段语义
 * 各自不同，平台层必须自己重新解析，不能依赖上游的解析结果。
 *
 * 本函数同时接受三种入参：
 * - 字符串：`k=v; k2=v2`
 * - 对象：上游已解析好的 cookie 对象
 * - 空值：返回空对象
 */

/**
 * 把 cookie 解析成键值对
 * @param {string | Record<string, any> | null | undefined} cookie cookie 来源
 * @returns {Record<string, string>} 解析后的 cookie 键值对
 */
const parseCookie = (cookie) => {
  if (!cookie) return {}
  if (typeof cookie === 'object') return { ...cookie }

  return String(cookie)
    .split(';')
    .reduce((acc, pair) => {
      const index = pair.indexOf('=')
      if (index <= 0) return acc
      const key = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (key) acc[key] = value
      return acc
    }, {})
}

/**
 * 把 cookie 键值对拼回字符串
 * @param {Record<string, any> | null | undefined} cookie cookie 键值对
 * @returns {string} cookie 字符串，无内容时返回空串
 */
const stringifyCookie = (cookie) => {
  if (!cookie) return ''
  return Object.entries(cookie)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

module.exports = {
  parseCookie,
  stringifyCookie,
}
