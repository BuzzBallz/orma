import { createContext } from 'react'
import type { Asset } from './types'

/**
 * The asset of the facility on screen, set at the root of its desk. The API sends XRP in drops and
 * an issued currency or an MPT in its own unit; read as drops, 15000 USD showed as 0.015 XRP.
 */
export const AmountAsset = createContext<Asset | null>(null)
