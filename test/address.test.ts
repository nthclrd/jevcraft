import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAddress } from '../src/address.ts'

test('a plain host keeps the default port', () => {
  assert.deepEqual(parseAddress('play.example.com'), { host: 'play.example.com' })
  assert.deepEqual(parseAddress('localhost'), { host: 'localhost' })
})

test('host:port and [ipv6]:port split the port out', () => {
  assert.deepEqual(parseAddress('192.168.1.20:25566'), { host: '192.168.1.20', port: 25566 })
  assert.deepEqual(parseAddress('mc.example.net:25565'), { host: 'mc.example.net', port: 25565 })
  assert.deepEqual(parseAddress('[2001:db8::1]:25565'), { host: '2001:db8::1', port: 25565 })
})

test('a bare IPv6 address is not mistaken for host:port', () => {
  assert.deepEqual(parseAddress('2001:db8::1'), { host: '2001:db8::1' })
  assert.deepEqual(parseAddress('::1'), { host: '::1' })
})

test('a trailing empty port is dropped', () => {
  assert.deepEqual(parseAddress('example.com:'), { host: 'example.com' })
})
