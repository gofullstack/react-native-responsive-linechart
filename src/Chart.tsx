import * as React from 'react'
import deepmerge from 'deepmerge'
import { Animated, View, ViewStyle } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import fastEqual from 'fast-deep-equal/react'
import clamp from 'lodash.clamp'
import minBy from 'lodash.minby'
import maxBy from 'lodash.maxby'
import Svg, { G, Mask, Defs, Rect } from 'react-native-svg'
import { useComponentDimensions } from './useComponentDimensions'
import { AxisDomain, ChartDataPoint, Padding, ViewPort, TouchEvent, XYValue } from './types'
import { ChartContextProvider } from './ChartContext'
import { calculateDataDimensions, calculateViewportDomain } from './Chart.utils'
import { scalePointToDimensions } from './utils'

export interface ChartProps extends React.PropsWithChildren {
  /** All styling can be used except for padding. If you need padding, use the explicit `padding` prop below.*/
  style?: ViewStyle
  /** Data to be used by `<Area />` or `<Line />` children. Not required, and can be overridden in Area or Line components. */
  data?: ChartDataPoint[]
  /** Domain for the horizontal (X) axis. */
  xDomain?: AxisDomain
  /** Domain for the vertical (Y) axis. */
  yDomain?: AxisDomain
  /** Size of the viewport for the chart. Should always be <= the domain. */
  viewport?: ViewPort
  /** This disables touch for the chart. You can use this if you don't need tooltips. */
  disableTouch?: boolean
  /** This disables gestures for the chart. You can use this if you don't need scrolling in the chart. */
  disableGestures?: boolean
  /** Padding of the chart. Use this instead of setting padding in the `style` prop. */
  padding?: Padding
}

export type ChartHandle = {
  setViewportOrigin: (origin: XYValue) => void
}

const Chart: React.FC<ChartProps> = React.memo(
  React.forwardRef<ChartHandle, ChartProps>(({ children, ...props }, ref) => {
    const { style, data = [], padding, xDomain, yDomain, viewport, disableGestures, disableTouch } = deepmerge(computeDefaultProps(props), props)    
    const { dimensions, onLayout } = useComponentDimensions()
    const dataDimensions = calculateDataDimensions(dimensions, padding)

    const panStartRef = React.useRef({ x: 0, y: 0 })
    const panHandlerRef = React.useRef<{
      dataDimensions?: ReturnType<typeof calculateDataDimensions>
      viewport?: ViewPort
      xDomain?: AxisDomain
      yDomain?: AxisDomain
      padding?: Padding
      offset?: Animated.ValueXY
      setPanX?: (x: number) => void
      setPanY?: (y: number) => void
      setLastTouch?: (t: TouchEvent) => void
    }>({})

    const [lastTouch, setLastTouch] = React.useState<TouchEvent | undefined>(undefined)
    const [panX, setPanX] = React.useState<number>(viewport.initialOrigin.x)
    const [panY, setPanY] = React.useState<number>(viewport.initialOrigin.y)
    const [offset] = React.useState(new Animated.ValueXY({ x: viewport.initialOrigin.x, y: viewport.initialOrigin.y }))

    const viewportDomain = calculateViewportDomain(
      viewport,
      {
        x: xDomain,
        y: yDomain,
      },
      panX,
      panY
    )

    const setViewportOrigin = (origin: XYValue) => {
      if (dataDimensions) {
        setPanX(origin.x)
        setPanY(origin.y)
        offset.x.setValue(origin.x)
      }
    }

    React.useImperativeHandle(ref, () => ({ setViewportOrigin }))

    panHandlerRef.current = {
      dataDimensions,
      viewport,
      xDomain,
      yDomain,
      padding,
      offset,
      setPanX,
      setPanY,
      setLastTouch,
    }

    const composedPanGesture = React.useMemo(() => {
      return Gesture.Pan()
        .activeOffsetX([-5, 5])
        .failOffsetY([-8, 8])
        .minPointers(1)
        .runOnJS(true)
        .onStart(() => {
          const h = panHandlerRef.current
          if (h.offset) {
            panStartRef.current.x = (h.offset.x as any)._value
            panStartRef.current.y = (h.offset.y as any)._value
          }
        })
        .onUpdate((e: { translationX: number; translationY: number; x: number; y: number }) => {
          const h = panHandlerRef.current
          if (!h.dataDimensions) return
          const factorX = h.viewport!.size.width / h.dataDimensions.width
          const factorY = h.viewport!.size.height / h.dataDimensions.height
          const newX = panStartRef.current.x - e.translationX * factorX
          const newY = panStartRef.current.y + e.translationY * factorY
          h.setPanX?.(newX)
          h.setPanY?.(newY)
          h.setLastTouch?.({
            position: {
              x: clamp(e.x - (h.padding?.left ?? 0), 0, h.dataDimensions.width),
              y: clamp(e.y - (h.padding?.top ?? 0), 0, h.dataDimensions.height),
            },
            translation: { x: e.translationX, y: e.translationY },
            type: 'pan',
          })
        })
        .onEnd((e: { translationX: number; translationY: number; x: number; y: number }) => {
          const h = panHandlerRef.current
          if (!h.dataDimensions) return
          const factorX = h.viewport!.size.width / h.dataDimensions.width
          const factorY = h.viewport!.size.height / h.dataDimensions.height
          const newX = clamp(
            panStartRef.current.x - e.translationX * factorX,
            h.xDomain!.min,
            h.xDomain!.max - h.viewport!.size.width
          )
          const newY = clamp(
            panStartRef.current.y + e.translationY * factorY,
            h.yDomain!.min,
            h.yDomain!.max - h.viewport!.size.height
          )
          h.offset?.x.setValue(newX)
          h.offset?.y.setValue(newY)
          h.setPanX?.(newX)
          h.setPanY?.(newY)
          h.setLastTouch?.({
            position: {
              x: clamp(e.x - (h.padding?.left ?? 0), 0, h.dataDimensions.width),
              y: clamp(e.y - (h.padding?.top ?? 0), 0, h.dataDimensions.height),
            },
            translation: { x: e.translationX, y: e.translationY },
            type: 'panEnd',
          })
        })
    }, [])

    const childComponents = React.Children.toArray(children)
    // undefined because ForwardRef (Line) has name undefined
    const lineAndAreaComponents = childComponents.filter((c) => ['Area', undefined].includes((c as any)?.type?.name))
    const otherComponents = childComponents.filter((c) => !['Area', undefined].includes((c as any)?.type?.name))

    const innerChart =
      dimensions &&
      dataDimensions && (
        <View style={{ width: dimensions.width, height: dimensions.height }}>
          <ChartContextProvider
            value={{
              data,
              dimensions: dataDimensions,
              domain: { x: xDomain, y: yDomain },
              viewportDomain,
              viewportOrigin: scalePointToDimensions(
                { x: viewportDomain.x.min, y: viewportDomain.y.max },
                viewportDomain,
                dataDimensions
              ),
              viewport,
              lastTouch,
            }}
          >
            <Svg width={dimensions.width} height={dimensions.height}>
              <G translateX={padding.left} translateY={padding.top}>
                {otherComponents}
                <Defs>
                  <Mask id="Mask" x={0} y={0} width={dataDimensions.width} height={dataDimensions.height}>
                    <Rect x="0" y="0" width={dataDimensions.width} height={dataDimensions.height} fill="#ffffff" />
                  </Mask>
                </Defs>
                {lineAndAreaComponents}
              </G>
            </Svg>
          </ChartContextProvider>
        </View>
      )

    const chartContent =
      dimensions &&
      (disableGestures ? innerChart : <GestureDetector gesture={composedPanGesture}>{innerChart}</GestureDetector>)

    return (
      <View style={style} onLayout={onLayout}>
        <GestureHandlerRootView>{chartContent}</GestureHandlerRootView>
      </View>
    )
  }),
  fastEqual
)

export { Chart }

const computeDefaultProps = (props: ChartProps) => {
  const { data = [] } = props

  const xDomain = props.xDomain ?? {
    min: data.length > 0 ? minBy(data, (d) => d.x)!.x : 0,
    max: data.length > 0 ? maxBy(data, (d) => d.x)!.x : 10,
  }

  const yDomain = props.yDomain ?? {
    min: data.length > 0 ? minBy(data, (d) => d.y)!.y : 0,
    max: data.length > 0 ? maxBy(data, (d) => d.y)!.y : 10,
  }

  return {
    padding: {
      left: 0,
      top: 0,
      bottom: 0,
      right: 0,
    },
    xDomain,
    yDomain,
    viewport: {
      size: { width: Math.abs(xDomain.max - xDomain.min), height: Math.abs(yDomain.max - yDomain.min) },
      initialOrigin: { x: xDomain.min, y: yDomain.min },
    },
  }
}
