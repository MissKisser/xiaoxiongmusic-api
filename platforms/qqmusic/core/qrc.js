/**
 * QQ 音乐歌词解密与解析
 *
 * QQ 音乐歌词接口返回的是十六进制密文：三重 DES 解密后再 zlib 解压，
 * 得到 QRC（逐字歌词的 XML 封装）或 LRC（普通歌词）文本。
 *
 * 三重 DES 采用 LDDC 项目的实现，其初始置换 / 末置换的位序号与标准 DES
 * 存在一位偏移，因此**不能**用 OpenSSL 的 `des-ede3` 替代，必须内置实现。
 *
 * 来源：LDDC 项目 https://github.com/chenmozhijin/LDDC
 * 原始代码：LDDC/core/decryptor/tripledes.py
 */

const { inflateSync, inflateRawSync, unzipSync } = require('node:zlib')

const ENCRYPT = 1
const DECRYPT = 0

// S-boxes
const sbox = [
  // sbox1
  [
    14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2,
    13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7,
    3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
  ],
  // sbox2
  [
    15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8,
    15, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9,
    3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
  ],
  // sbox3
  [
    10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6,
    10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5,
    10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
  ],
  // sbox4
  [
    7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15,
    0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14,
    5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
  ],
  // sbox5
  [
    2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7,
    13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6,
    3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
  ],
  // sbox6
  [
    12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12,
    9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1,
    13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
  ],
  // sbox7
  [
    4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1,
    10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0,
    5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
  ],
  // sbox8
  [
    13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3,
    7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13,
    15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
  ],
]

/**
 * 读取字节数组的第 b 位并左移到第 c 位
 *
 * @param {Uint8Array} a 字节数组
 * @param {number} b 位序号
 * @param {number} c 目标位序号
 * @returns {number} 取出的位值
 */
const bitnum = (a, b, c) => {
  const byteIndex = Math.floor(b / 32) * 4 + 3 - Math.floor((b % 32) / 8)
  return ((a[byteIndex] >> (7 - (b % 8))) & 1) << c
}

/**
 * 读取整数的第 b 位并左移到第 c 位
 *
 * @param {number} a 整数
 * @param {number} b 位序号
 * @param {number} c 目标位序号
 * @returns {number} 取出的位值
 */
const bitnumIntr = (a, b, c) => ((a >> (31 - b)) & 1) << c

/**
 * 循环左移后取位，用于 DES 的 Feistel 网络
 *
 * @param {number} a 整数
 * @param {number} b 位序号
 * @param {number} c 目标位序号
 * @returns {number} 取出的位值
 */
const bitnumIntl = (a, b, c) => (((a << b) & 0x80000000) >>> c) >>> 0

/**
 * 把 6 位值置换为 S 盒索引
 *
 * @param {number} a 输入值
 * @returns {number} S 盒索引
 */
const sboxBit = (a) => (a & 32) | ((a & 31) >> 1) | ((a & 1) << 4)

/**
 * 初始置换 IP
 *
 * @param {Uint8Array} inputData 输入分组
 * @returns {[number, number]} 左右两半
 */
const initialPermutation = (inputData) => {
  const s0 =
    (bitnum(inputData, 57, 31) |
      bitnum(inputData, 49, 30) |
      bitnum(inputData, 41, 29) |
      bitnum(inputData, 33, 28) |
      bitnum(inputData, 25, 27) |
      bitnum(inputData, 17, 26) |
      bitnum(inputData, 9, 25) |
      bitnum(inputData, 1, 24) |
      bitnum(inputData, 59, 23) |
      bitnum(inputData, 51, 22) |
      bitnum(inputData, 43, 21) |
      bitnum(inputData, 35, 20) |
      bitnum(inputData, 27, 19) |
      bitnum(inputData, 19, 18) |
      bitnum(inputData, 11, 17) |
      bitnum(inputData, 3, 16) |
      bitnum(inputData, 61, 15) |
      bitnum(inputData, 53, 14) |
      bitnum(inputData, 45, 13) |
      bitnum(inputData, 37, 12) |
      bitnum(inputData, 29, 11) |
      bitnum(inputData, 21, 10) |
      bitnum(inputData, 13, 9) |
      bitnum(inputData, 5, 8) |
      bitnum(inputData, 63, 7) |
      bitnum(inputData, 55, 6) |
      bitnum(inputData, 47, 5) |
      bitnum(inputData, 39, 4) |
      bitnum(inputData, 31, 3) |
      bitnum(inputData, 23, 2) |
      bitnum(inputData, 15, 1) |
      bitnum(inputData, 7, 0)) >>>
    0

  const s1 =
    (bitnum(inputData, 56, 31) |
      bitnum(inputData, 48, 30) |
      bitnum(inputData, 40, 29) |
      bitnum(inputData, 32, 28) |
      bitnum(inputData, 24, 27) |
      bitnum(inputData, 16, 26) |
      bitnum(inputData, 8, 25) |
      bitnum(inputData, 0, 24) |
      bitnum(inputData, 58, 23) |
      bitnum(inputData, 50, 22) |
      bitnum(inputData, 42, 21) |
      bitnum(inputData, 34, 20) |
      bitnum(inputData, 26, 19) |
      bitnum(inputData, 18, 18) |
      bitnum(inputData, 10, 17) |
      bitnum(inputData, 2, 16) |
      bitnum(inputData, 60, 15) |
      bitnum(inputData, 52, 14) |
      bitnum(inputData, 44, 13) |
      bitnum(inputData, 36, 12) |
      bitnum(inputData, 28, 11) |
      bitnum(inputData, 20, 10) |
      bitnum(inputData, 12, 9) |
      bitnum(inputData, 4, 8) |
      bitnum(inputData, 62, 7) |
      bitnum(inputData, 54, 6) |
      bitnum(inputData, 46, 5) |
      bitnum(inputData, 38, 4) |
      bitnum(inputData, 30, 3) |
      bitnum(inputData, 22, 2) |
      bitnum(inputData, 14, 1) |
      bitnum(inputData, 6, 0)) >>>
    0

  return [s0, s1]
}

/**
 * 末置换 FP
 *
 * @param {number} s0 右半
 * @param {number} s1 左半
 * @returns {Uint8Array} 输出分组
 */
const inversePermutation = (s0, s1) => {
  const data = new Uint8Array(8)

  data[3] =
    bitnumIntr(s1, 7, 7) |
    bitnumIntr(s0, 7, 6) |
    bitnumIntr(s1, 15, 5) |
    bitnumIntr(s0, 15, 4) |
    bitnumIntr(s1, 23, 3) |
    bitnumIntr(s0, 23, 2) |
    bitnumIntr(s1, 31, 1) |
    bitnumIntr(s0, 31, 0)

  data[2] =
    bitnumIntr(s1, 6, 7) |
    bitnumIntr(s0, 6, 6) |
    bitnumIntr(s1, 14, 5) |
    bitnumIntr(s0, 14, 4) |
    bitnumIntr(s1, 22, 3) |
    bitnumIntr(s0, 22, 2) |
    bitnumIntr(s1, 30, 1) |
    bitnumIntr(s0, 30, 0)

  data[1] =
    bitnumIntr(s1, 5, 7) |
    bitnumIntr(s0, 5, 6) |
    bitnumIntr(s1, 13, 5) |
    bitnumIntr(s0, 13, 4) |
    bitnumIntr(s1, 21, 3) |
    bitnumIntr(s0, 21, 2) |
    bitnumIntr(s1, 29, 1) |
    bitnumIntr(s0, 29, 0)

  data[0] =
    bitnumIntr(s1, 4, 7) |
    bitnumIntr(s0, 4, 6) |
    bitnumIntr(s1, 12, 5) |
    bitnumIntr(s0, 12, 4) |
    bitnumIntr(s1, 20, 3) |
    bitnumIntr(s0, 20, 2) |
    bitnumIntr(s1, 28, 1) |
    bitnumIntr(s0, 28, 0)

  data[7] =
    bitnumIntr(s1, 3, 7) |
    bitnumIntr(s0, 3, 6) |
    bitnumIntr(s1, 11, 5) |
    bitnumIntr(s0, 11, 4) |
    bitnumIntr(s1, 19, 3) |
    bitnumIntr(s0, 19, 2) |
    bitnumIntr(s1, 27, 1) |
    bitnumIntr(s0, 27, 0)

  data[6] =
    bitnumIntr(s1, 2, 7) |
    bitnumIntr(s0, 2, 6) |
    bitnumIntr(s1, 10, 5) |
    bitnumIntr(s0, 10, 4) |
    bitnumIntr(s1, 18, 3) |
    bitnumIntr(s0, 18, 2) |
    bitnumIntr(s1, 26, 1) |
    bitnumIntr(s0, 26, 0)

  data[5] =
    bitnumIntr(s1, 1, 7) |
    bitnumIntr(s0, 1, 6) |
    bitnumIntr(s1, 9, 5) |
    bitnumIntr(s0, 9, 4) |
    bitnumIntr(s1, 17, 3) |
    bitnumIntr(s0, 17, 2) |
    bitnumIntr(s1, 25, 1) |
    bitnumIntr(s0, 25, 0)

  data[4] =
    bitnumIntr(s1, 0, 7) |
    bitnumIntr(s0, 0, 6) |
    bitnumIntr(s1, 8, 5) |
    bitnumIntr(s0, 8, 4) |
    bitnumIntr(s1, 16, 3) |
    bitnumIntr(s0, 16, 2) |
    bitnumIntr(s1, 24, 1) |
    bitnumIntr(s0, 24, 0)

  return data
}

/**
 * DES 的轮函数 F
 *
 * @param {number} state 右半
 * @param {number[]} key 轮密钥
 * @returns {number} 轮函数结果
 */
const f = (state, key) => {
  const t1 =
    (bitnumIntl(state, 31, 0) |
      ((state & 0xf0000000) >>> 1) |
      bitnumIntl(state, 4, 5) |
      bitnumIntl(state, 3, 6) |
      ((state & 0x0f000000) >>> 3) |
      bitnumIntl(state, 8, 11) |
      bitnumIntl(state, 7, 12) |
      ((state & 0x00f00000) >>> 5) |
      bitnumIntl(state, 12, 17) |
      bitnumIntl(state, 11, 18) |
      ((state & 0x000f0000) >>> 7) |
      bitnumIntl(state, 16, 23)) >>>
    0

  const t2 =
    (bitnumIntl(state, 15, 0) |
      ((state & 0x0000f000) << 15) |
      bitnumIntl(state, 20, 5) |
      bitnumIntl(state, 19, 6) |
      ((state & 0x00000f00) << 13) |
      bitnumIntl(state, 24, 11) |
      bitnumIntl(state, 23, 12) |
      ((state & 0x000000f0) << 11) |
      bitnumIntl(state, 28, 17) |
      bitnumIntl(state, 27, 18) |
      ((state & 0x0000000f) << 9) |
      bitnumIntl(state, 0, 23)) >>>
    0

  const lrgstate = [
    ((t1 >>> 24) & 0x000000ff) ^ key[0],
    ((t1 >>> 16) & 0x000000ff) ^ key[1],
    ((t1 >>> 8) & 0x000000ff) ^ key[2],
    ((t2 >>> 24) & 0x000000ff) ^ key[3],
    ((t2 >>> 16) & 0x000000ff) ^ key[4],
    ((t2 >>> 8) & 0x000000ff) ^ key[5],
  ]

  state =
    ((sbox[0][sboxBit(lrgstate[0] >>> 2)] << 28) |
      (sbox[1][sboxBit(((lrgstate[0] & 0x03) << 4) | (lrgstate[1] >>> 4))] <<
        24) |
      (sbox[2][sboxBit(((lrgstate[1] & 0x0f) << 2) | (lrgstate[2] >>> 6))] <<
        20) |
      (sbox[3][sboxBit(lrgstate[2] & 0x3f)] << 16) |
      (sbox[4][sboxBit(lrgstate[3] >>> 2)] << 12) |
      (sbox[5][sboxBit(((lrgstate[3] & 0x03) << 4) | (lrgstate[4] >>> 4))] <<
        8) |
      (sbox[6][sboxBit(((lrgstate[4] & 0x0f) << 2) | (lrgstate[5] >>> 6))] <<
        4) |
      sbox[7][sboxBit(lrgstate[5] & 0x3f)]) >>>
    0

  return (
    (bitnumIntl(state, 15, 0) |
      bitnumIntl(state, 6, 1) |
      bitnumIntl(state, 19, 2) |
      bitnumIntl(state, 20, 3) |
      bitnumIntl(state, 28, 4) |
      bitnumIntl(state, 11, 5) |
      bitnumIntl(state, 27, 6) |
      bitnumIntl(state, 16, 7) |
      bitnumIntl(state, 0, 8) |
      bitnumIntl(state, 14, 9) |
      bitnumIntl(state, 22, 10) |
      bitnumIntl(state, 25, 11) |
      bitnumIntl(state, 4, 12) |
      bitnumIntl(state, 17, 13) |
      bitnumIntl(state, 30, 14) |
      bitnumIntl(state, 9, 15) |
      bitnumIntl(state, 1, 16) |
      bitnumIntl(state, 7, 17) |
      bitnumIntl(state, 23, 18) |
      bitnumIntl(state, 13, 19) |
      bitnumIntl(state, 31, 20) |
      bitnumIntl(state, 26, 21) |
      bitnumIntl(state, 2, 22) |
      bitnumIntl(state, 8, 23) |
      bitnumIntl(state, 18, 24) |
      bitnumIntl(state, 12, 25) |
      bitnumIntl(state, 29, 26) |
      bitnumIntl(state, 5, 27) |
      bitnumIntl(state, 21, 28) |
      bitnumIntl(state, 10, 29) |
      bitnumIntl(state, 3, 30) |
      bitnumIntl(state, 24, 31)) >>>
    0
  )
}

/**
 * 单次 DES 分组加密/解密（轮密钥顺序决定方向）
 *
 * @param {Uint8Array} inputData 输入分组
 * @param {number[][]} key 轮密钥表
 * @returns {Uint8Array} 输出分组
 */
const crypt = (inputData, key) => {
  let [s0, s1] = initialPermutation(inputData)

  for (let idx = 0; idx < 15; idx++) {
    const previousS1 = s1
    s1 = (f(s1, key[idx]) ^ s0) >>> 0
    s0 = previousS1
  }
  s0 = (f(s1, key[15]) ^ s0) >>> 0

  return inversePermutation(s0, s1)
}

/**
 * 生成 DES 轮密钥
 *
 * @param {Uint8Array} key 8 字节密钥
 * @param {number} mode 密钥顺序模式
 * @returns {number[][]} 16 轮轮密钥
 */
const keySchedule = (key, mode) => {
  const schedule = Array.from({ length: 16 }, () => Array(6).fill(0))
  const keyRndShift = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
  const keyPermC = [
    56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34,
    26, 18, 10, 2, 59, 51, 43, 35,
  ]
  const keyPermD = [
    62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44,
    36, 28, 20, 12, 4, 27, 19, 11, 3,
  ]
  const keyCompression = [
    13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3, 25, 7, 15, 6, 26,
    19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47, 43, 48, 38, 55,
    33, 52, 45, 41, 49, 35, 28, 31,
  ]

  let c = 0
  let d = 0
  for (let i = 0; i < 28; i++) {
    c |= bitnum(key, keyPermC[i], 31 - i)
    d |= bitnum(key, keyPermD[i], 31 - i)
  }

  for (let i = 0; i < 16; i++) {
    c =
      (((c << keyRndShift[i]) | (c >>> (28 - keyRndShift[i]))) & 0xfffffff0) >>>
      0
    d =
      (((d << keyRndShift[i]) | (d >>> (28 - keyRndShift[i]))) & 0xfffffff0) >>>
      0

    const togen = mode === DECRYPT ? 15 - i : i

    for (let j = 0; j < 6; j++) {
      schedule[togen][j] = 0
    }

    for (let j = 0; j < 24; j++) {
      schedule[togen][Math.floor(j / 8)] |= bitnumIntr(
        c,
        keyCompression[j],
        7 - (j % 8),
      )
    }

    for (let j = 24; j < 48; j++) {
      schedule[togen][Math.floor(j / 8)] |= bitnumIntr(
        d,
        keyCompression[j] - 27,
        7 - (j % 8),
      )
    }
  }

  return schedule
}

/**
 * 生成三重 DES 的三组轮密钥
 *
 * @param {Uint8Array} key 24 字节密钥
 * @param {number} mode 密钥顺序模式
 * @returns {number[][][]} 三组轮密钥
 */
const tripleDesKeySetup = (key, mode) => {
  if (mode === ENCRYPT) {
    return [
      keySchedule(key.slice(0), ENCRYPT),
      keySchedule(key.slice(8), DECRYPT),
      keySchedule(key.slice(16), ENCRYPT),
    ]
  }
  return [
    keySchedule(key.slice(16), DECRYPT),
    keySchedule(key.slice(8), ENCRYPT),
    keySchedule(key.slice(0), DECRYPT),
  ]
}

/**
 * 执行三重 DES 分组运算
 *
 * @param {Uint8Array} data 输入分组
 * @param {number[][][]} key 三组轮密钥
 * @returns {Uint8Array} 输出分组
 */
const tripleDesCrypt = (data, key) => {
  let result = data
  for (let i = 0; i < 3; i++) {
    result = crypt(result, key[i])
  }
  return result
}

/**
 * 解密 QRC 歌词
 * @param encryptedData - 加密的字节数组
 * @param key - 24字节密钥
 * @returns 解密后的字节数组
 */
/**
 * 三重 DES 解密
 *
 * @param {Uint8Array} encryptedData 密文数据
 * @param {Uint8Array} key 24 字节密钥
 * @returns {Uint8Array} 解密后的数据
 */
const qrcDecrypt = (encryptedData, key) => {
  const schedule = tripleDesKeySetup(key, DECRYPT)
  const result = []

  // 以 8 字节为单位迭代
  for (let i = 0; i < encryptedData.length; i += 8) {
    const block = encryptedData.slice(i, i + 8)
    const decrypted = tripleDesCrypt(block, schedule)
    result.push(...decrypted)
  }

  return new Uint8Array(result)
}

/**
 * QRC 解密密钥（24 字节）
 * @type {Buffer}
 */
const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'utf8')

/**
 * 解密 QQ 音乐歌词密文
 *
 * 密文是十六进制字符串，先做三重 DES 解密，再按 zlib / raw inflate / gzip
 * 三种方式依次尝试解压。
 * @param {string} encryptedQrc 十六进制密文
 * @returns {string} 解密后的歌词原文
 */
const decryptQrc = (encryptedQrc) => {
  if (!encryptedQrc || String(encryptedQrc).trim() === '') {
    throw new Error('没有可解密的数据')
  }

  const encryptedBuffer = Buffer.from(String(encryptedQrc), 'hex')
  const decrypted = Buffer.from(
    qrcDecrypt(new Uint8Array(encryptedBuffer), new Uint8Array(QRC_KEY)),
  )

  try {
    return inflateSync(decrypted).toString('utf8')
  } catch (err) {
    // 换下一种压缩格式
  }
  try {
    return inflateRawSync(decrypted).toString('utf8')
  } catch (err) {
    // 换下一种压缩格式
  }
  try {
    return unzipSync(decrypted).toString('utf8')
  } catch (err) {
    // 换下一种压缩格式
  }

  const text = decrypted.toString('utf8')
  if (text.includes('[') || text.includes('<')) return text

  throw new Error('无法解压数据')
}

/**
 * 解开 XML 实体
 * @param {string} text 原始文本
 * @returns {string} 解开后的文本
 */
const decodeXmlEntities = (text) =>
  String(text)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/**
 * 从 QRC 的 XML 封装里取出歌词正文
 *
 * QRC 文本形如：
 * `<?xml ...?><QrcInfos><LyricInfo><Lyric_1 LyricType="1" LyricContent="..."/>`
 * @param {string} text 歌词原文
 * @returns {{ format: string, content: string }} 歌词格式与正文
 */
const extractContent = (text) => {
  const source = String(text || '')
  const match = source.match(/LyricContent="([\s\S]*?)"(?:\s*\/>|\s*>)/)
  if (!match) return { format: 'lrc', content: source }
  return { format: 'qrc', content: decodeXmlEntities(match[1]) }
}

/**
 * 解析 LRC 行的时间标签
 * @param {string} tag 时间标签，如 `00:12.34`
 * @returns {number} 毫秒数，解析失败返回 0
 */
const parseLrcTag = (tag) => {
  const matched = String(tag).match(/(\d+):(\d{1,2})(?:[.:](\d{1,3}))?/)
  if (!matched) return 0
  const minutes = Number(matched[1])
  const seconds = Number(matched[2])
  const fraction = matched[3] ? Number('0.' + matched[3]) : 0
  return Math.round((minutes * 60 + seconds) * 1000 + fraction * 1000)
}

/**
 * 解析 QRC 行的逐字内容
 *
 * 行格式为 `[行起始毫秒,行时长毫秒]字(相对起始毫秒,时长毫秒)字(...)`
 * @param {string} body 行正文
 * @returns {{ words: Array<Record<string, any>>, text: string }} 逐字信息
 */
const parseQrcBody = (body) => {
  const words = []
  const pattern = /\((\d+),(\d+)\)/g
  let cursor = 0
  let matched = pattern.exec(body)

  while (matched !== null) {
    words.push({
      text: body.slice(cursor, matched.index),
      start: Number(matched[1]),
      duration: Number(matched[2]),
    })
    cursor = matched.index + matched[0].length
    matched = pattern.exec(body)
  }

  return { words, text: words.map((word) => word.text).join('') }
}

/**
 * 把歌词正文解析成逐行（逐字）结构
 * @param {string} content 歌词正文
 * @param {string} format 歌词格式：qrc / lrc
 * @returns {Array<Record<string, any>>} 歌词行数组
 */
const parseLines = (content, format) => {
  const lines = []
  const text = String(content || '')

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    if (format === 'qrc') {
      const matched = line.match(/^\[(\d+),(\d+)\](.*)$/)
      if (!matched) continue
      const lineStart = Number(matched[1])
      const parsed = parseQrcBody(matched[3])
      lines.push({
        time: lineStart,
        duration: Number(matched[2]),
        text: parsed.text,
        words: parsed.words.map((word) => ({
          text: word.text,
          start: lineStart + word.start,
          duration: word.duration,
        })),
      })
      continue
    }

    const matched = line.match(/^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\](.*)$/)
    if (!matched) continue
    lines.push({
      time: parseLrcTag(matched[1] + ':' + matched[2]),
      duration: 0,
      text: matched[3].trim(),
      words: [],
    })
  }

  return lines
}

/**
 * 解析 QQ 音乐歌词文本
 *
 * 同时兼容 QRC 的 XML 封装与裸 LRC 文本。
 * @param {string} text 歌词原文
 * @returns {{ format: string, content: string, lines: Array<Record<string, any>> }} 解析结果
 */
const parseLyric = (text) => {
  const { format, content } = extractContent(text)
  return { format, content, lines: parseLines(content, format) }
}

module.exports = {
  decryptQrc,
  parseLyric,
}
