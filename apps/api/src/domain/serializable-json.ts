export type SerializableJson =
  | null
  | string
  | number
  | boolean
  | Date
  | readonly SerializableJson[]
  | { readonly [key: string]: SerializableJson | undefined };
