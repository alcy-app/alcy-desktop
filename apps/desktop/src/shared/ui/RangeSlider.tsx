import { forwardRef, type InputHTMLAttributes } from 'react'
import './range-slider.css'

type RangeSliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

export const RangeSlider = forwardRef<HTMLInputElement, RangeSliderProps>(function RangeSlider(
  { className, ...rest },
  ref,
) {
  const classes = className ? `ui-range-slider ${className}` : 'ui-range-slider'
  return <input ref={ref} type="range" className={classes} {...rest} />
})
