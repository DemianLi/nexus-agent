import { Formatter } from '@nexus/cordis'
import { inspect } from 'node:util'
import { ConsoleExporter as Base } from './shared.js'

export * from './shared.js'

const inspectFormatter: Formatter = (value, target) => {
  return inspect(value, { colors: !!target.colors, depth: Infinity, compact: true, breakLength: Infinity })
}

export class ConsoleExporter extends Base {
  formatters: Record<string, Formatter> = {
    o: inspectFormatter,
    O: inspectFormatter,
  }

  getDefaults() {
    return {
      ...super.getDefaults(),
      colors: false as false | 0 | 1 | 2 | 3,
    }
  }
}

export default ConsoleExporter
