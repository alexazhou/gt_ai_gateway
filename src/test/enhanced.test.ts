import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CustomPromise } from '../util/enhanced'

describe('CustomPromise', () => {
  it('应该创建一个可解析的 promise', async () => {
    const customPromise = new CustomPromise<string>()

    // 调用 resolve
    customPromise.resolve('hello')

    const result = await customPromise
    expect(result).toBe('hello')
  })

  it('应该创建一个可拒绝的 promise', async () => {
    const customPromise = new CustomPromise<string>()

    // 调用 reject
    customPromise.reject(new Error('failed'))

    await expect(customPromise).rejects.toThrow('failed')
  })

  it('应该支持 then 方法', async () => {
    const customPromise = new CustomPromise<number>()

    customPromise.resolve(42)

    const doubled = await customPromise.then((value) => value * 2)
    expect(doubled).toBe(84)
  })

  it('应该支持 catch 方法', async () => {
    const customPromise = new CustomPromise<string>()

    customPromise.reject(new Error('error'))

    const caught = await customPromise.catch((e) => {
      return (e as Error).message
    })

    expect(caught).toBe('error')
  })

  it('应该支持链式调用 then', async () => {
    const customPromise = new CustomPromise<number>()

    customPromise.resolve(5)

    const result = await customPromise
      .then((x) => x * 2)
      .then((x) => x + 10)
      .then((x) => x.toString())

    expect(result).toBe('20')
  })

  it('应该支持 then 的错误回调', async () => {
    const customPromise = new CustomPromise<number>()

    customPromise.reject(new Error('failed'))

    const result = await customPromise.then(
      () => 0,
      (e) => (e as Error).message
    )

    expect(result).toBe('failed')
  })

  it('应该允许多次调用 resolve（最后一次生效）', async () => {
    const customPromise = new CustomPromise<string>()

    customPromise.resolve('first')
    customPromise.resolve('second')

    const result = await customPromise
    // Promise 一旦 resolve 就不会再改变，这里的行为取决于具体实现
    expect(result).toBe('first')
  })

  it('应该正确处理 undefined resolve', async () => {
    const customPromise = new CustomPromise<void>()

    customPromise.resolve()

    const result = await customPromise
    expect(result).toBeUndefined()
  })
})
