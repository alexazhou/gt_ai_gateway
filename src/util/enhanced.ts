
class CustomPromise<T> {
    private _resolve!: (value?: any) => void;
    private _reject!: (reason?: any) => void;
    private promise: Promise<T>;

    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    // 提供对外部访问的 resolve 和 reject 方法
    get resolve() {
        return this._resolve;
    }

    get reject() {
        return this._reject;
    }

    // 实现 thenable 接口
    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
        onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onfulfilled, onrejected);
    }

    catch(onrejected?: ((reason: any) => any) | undefined | null): Promise<T> {
        return this.promise.catch(onrejected);
    }
}

export {
    CustomPromise
}