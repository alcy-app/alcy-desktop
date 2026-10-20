import { createContext } from 'react'

/** Transformed surfaces can opt out of overlay animations without changing other application surfaces. */
export const OverlayMotionContext = createContext(true)
