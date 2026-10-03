// lz4js ships no types: the one function decode.ts uses.
declare const lz4: { decompress(input: Uint8Array, maxSize?: number): ArrayLike<number> }
export default lz4
