import type { ReactNode } from 'react'
import { APP_EXTENSIONS } from './registry'

const wrappers = APP_EXTENSIONS.flatMap((extension) => (extension.AppWrapper ? [extension.AppWrapper] : []))

/** Nests every extension's `AppWrapper` around `children`, the first extension outermost. */
export function ExtensionWrappers({ children }: { children: ReactNode }) {
  return wrappers.reduceRight<ReactNode>((inner, Wrapper) => <Wrapper>{inner}</Wrapper>, children)
}
