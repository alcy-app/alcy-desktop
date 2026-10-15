import { describe, expect, it } from 'vitest'
import type { GrpcMethodSummary } from '../../bindings/load-grpc-schema'
import { findGrpcMethod, grpcMessageSchema, shortServiceName } from './grpc-schema'

const method: GrpcMethodSummary = {
  name: 'SayHello',
  kind: 'unary',
  inputType: 'test.HelloRequest',
  outputType: 'test.HelloReply',
  inputTemplate: '{}',
  inputSchema: {
    type: 'object',
    properties: {
      person: {
        type: 'object',
        properties: { mood: { enum: ['MOOD_UNSPECIFIED', 'HAPPY'] }, tags: { type: 'array', items: { type: 'string' } } },
      },
      scores: { type: 'object', additionalProperties: { type: ['integer', 'string'] } },
      avatar: { type: 'string', contentEncoding: 'base64' },
    },
  },
}

describe('grpcMessageSchema', () => {
  it('converts the JSON Schema of the input into completion nodes', () => {
    const { root } = grpcMessageSchema(method)
    expect(root.types).toEqual(['object'])
    expect(root.properties.map((property) => property.name)).toEqual(['person', 'scores', 'avatar'])
    const person = root.properties[0].schema
    expect(person.properties[0].schema.enumValues).toEqual(['MOOD_UNSPECIFIED', 'HAPPY'])
    expect(person.properties[1].schema.items?.types).toEqual(['string'])
    expect(root.properties[1].schema.additionalProperties?.types).toEqual(['integer', 'string'])
    expect(root.properties[2].schema.format).toBe('byte')
  })
})

describe('findGrpcMethod', () => {
  it('finds a method by service and name', () => {
    const schema = { services: [{ name: 'test.Greeter', methods: [method] }] }
    expect(findGrpcMethod(schema, 'test.Greeter', 'SayHello')).toBe(method)
    expect(findGrpcMethod(schema, 'test.Greeter', 'Nope')).toBeNull()
    expect(shortServiceName('test.v1.Greeter')).toBe('Greeter')
    expect(shortServiceName('Greeter')).toBe('Greeter')
  })
})
