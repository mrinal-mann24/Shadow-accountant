// Helpers over the generated schema. Never edit database.types.ts by hand.
import type { Database, Json } from './database.types'

export type { Database, Json }

type PublicSchema = Database['public']

export type TableName = keyof PublicSchema['Tables']
export type ViewName = keyof PublicSchema['Views']

export type Row<T extends TableName> = PublicSchema['Tables'][T]['Row']
export type Insert<T extends TableName> = PublicSchema['Tables'][T]['Insert']
export type Update<T extends TableName> = PublicSchema['Tables'][T]['Update']
export type ViewRow<V extends ViewName> = PublicSchema['Views'][V]['Row']
