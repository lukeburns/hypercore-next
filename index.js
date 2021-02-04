const { EventEmitter } = require('events')
const raf = require('random-access-file')
const isOptions = require('is-options')
const codecs = require('codecs')
const crypto = require('hypercore-crypto')
const MerkleTree = require('./lib/merkle-tree')
const BlockStore = require('./lib/block-store')
const Bitfield = require('./lib/bitfield')
const Replicator = require('./lib/replicator')
const Info = require('./lib/info')
const Writer = require('./lib/writer')
const Extension = require('./lib/extension')
const lock = requireMaybe('fd-lock')

const promises = Symbol.for('hypercore.promises')
const inspect = Symbol.for('nodejs.util.inspect.custom')

module.exports = class Omega extends EventEmitter {
  constructor (storage, key, opts) {
    super()

    if (isOptions(key)) {
      opts = key
      key = null
    }
    if (!opts) opts = {}

    this[promises] = true
    this.crypto = crypto
    this.storage = defaultStorage(storage)
    this.tree = null
    this.blocks = null
    this.bitfield = null
    this.info = null
    this.writer = null
    this.replicator = null
    this.extensions = Extension.createLocal(this)

    this.valueEncoding = opts.valueEncoding ? codecs(opts.valueEncoding) : null
    this.key = key || null
    this.discoveryKey = null
    this.opened = false
    this.readable = true // TODO: set to false when closing

    this.opening = this.ready()
    this.opening.catch(noop)

    this._externalSecretKey = opts.secretKey || null
  }

  [inspect] (depth, opts) {
    let indent = ''
    if (typeof opts.indentationLvl === 'number') {
      while (indent.length < opts.indentationLvl) indent += ' '
    }

    return 'Omega(\n' +
      indent + '  key: ' + opts.stylize((toHex(this.key)), 'string') + '\n' +
      indent + '  discoveryKey: ' + opts.stylize(toHex(this.discoveryKey), 'string') + '\n' +
      indent + '  opened: ' + opts.stylize(this.opened, 'boolean') + '\n' +
      indent + '  writable: ' + opts.stylize(this.writable, 'boolean') + '\n' +
      indent + '  length: ' + opts.stylize(this.length, 'number') + '\n' +
      indent + '  byteLength: ' + opts.stylize(this.byteLength, 'number') + '\n' +
      indent + ')'
  }

  static createProtocolStream () {
    return Replicator.createStream()
  }

  session () {
    return this
  }

  async close () {
    await this.opening

    await Promise.all([
      this.bitfield.close(),
      this.info.close(),
      this.tree.close(),
      this.blocks.close()
    ])
  }

  replicate (isInitiator, opts = {}) {
    let stream = isStream(isInitiator)
      ? isInitiator
      : opts.stream

    if (!stream) stream = Replicator.createStream()

    if (this.opened) {
      this.replicator.joinStream(stream)
    } else {
      const join = this.replicator.joinStream.bind(this.replicator, stream)
      this.opening.then(join, stream.destroy.bind(stream))
    }

    return stream
  }

  get writable () {
    return this.writer !== null
  }

  get length () {
    return this.tree === null ? 0 : this.tree.length
  }

  get byteLength () {
    return this.tree === null ? 0 : this.tree.byteLength
  }

  get fork () {
    return this.tree === null ? 0 : this.tree.fork
  }

  get peers () {
    return this.replicator.peers
  }

  async ready () {
    if (this.opening) return this.opening

    this.info = await Info.open(this.storage('info'))

    // TODO: move to info.keygen or something?
    if (!this.info.publicKey) {
      if (this.key) {
        this.info.publicKey = this.key
        this.info.secretKey = this._externalSecretKey
      } else {
        const keys = this.crypto.keyPair()
        this.info.publicKey = this.key = keys.publicKey
        this.info.secretKey = keys.secretKey
      }
      await this.info.flush()
    } else {
      this.key = this.info.publicKey
    }

    // TODO: allow this to not be persisted
    const { secretKey } = this.info

    if (this.key && this.info.publicKey) {
      if (!this.key.equals(this.info.publicKey)) {
        throw new Error('Another hypercore is stored here')
      }
    }

    this.replicator = new Replicator(this)
    this.tree = await MerkleTree.open(this.storage('tree'), { crypto: this.crypto, fork: this.info.fork })
    this.blocks = new BlockStore(this.storage('data'), this.tree)
    this.bitfield = await Bitfield.open(this.storage('bitfield'))
    if (secretKey) this.writer = new Writer(secretKey, this)

    this.discoveryKey = this.crypto.discoveryKey(this.key)
    this.opened = true
  }

  async update () {
    if (this.opened === false) await this.opening
    // TODO: add an option where a writer can bootstrap it's state from the network also
    if (this.writer !== null) return false
    return this.replicator.requestUpgrade()
  }

  async seek (bytes) {
    if (this.opened === false) await this.opening

    const s = this.tree.seek(bytes)

    return (await s.update()) || this.replicator.requestSeek(s)
  }

  async has (index) {
    if (this.opened === false) await this.opening

    return this.bitfield.get(index)
  }

  async get (index, opts) {
    if (this.opened === false) await this.opening
    const encoding = (opts && opts.valueEncoding) || this.valueEncoding

    if (this.bitfield.get(index)) return decode(encoding, await this.blocks.get(index))
    if (opts && opts.onwait) opts.onwait(index)

    return decode(encoding, await this.replicator.requestBlock(index))
  }

  download (range) {
    return this.replicator.requestRange(range.start, range.end, !!range.linear)
  }

  undownload (range) {
    range.destroy(null)
  }

  async truncate (len = 0, fork = -1) {
    if (this.opened === false) await this.opening
    return this.writer.truncate(len, fork)
  }

  async append (datas) {
    if (this.opened === false) await this.opening
    return this.writer.append(Array.isArray(datas) ? datas : [datas])
  }

  registerExtension (name, handlers) {
    const ext = this.extensions.add(name, handlers)
    this.replicator.broadcastOptions()
    return ext
  }

  // called by the writer
  ontruncate () {
    this.emit('truncate')
  }

  // called by the writer
  onappend () {
    this.emit('append')
  }

  // called by the replicator
  ondownload (block, upgraded, peer) {
    if (block) {
      this.emit('download', block.index, block.value, peer)
    }
    if (upgraded) {
      this.emit('append')
    }
  }

  // called by the replicator
  onreorg () {
    this.emit('reorg', this.info.fork)
  }

  onpeeradd (peer) {
    this.emit('peer-add', peer)
  }

  onpeerremove (peer) {
    this.emit('peer-remove', peer)
  }
}

function noop () {}

function defaultStorage (storage) {
  if (typeof storage === 'string') {
    const directory = storage
    return name => raf(name, { directory, lock: name === 'info' ? lock : null })
  }
  return storage
}

function decode (enc, buf) {
  return enc ? enc.decode(buf) : buf
}

function isStream (s) {
  return typeof s === 'object' && s && typeof s.pipe === 'function'
}

function requireMaybe (name) {
  try {
    return require(name)
  } catch (_) {
    return null
  }
}

function toHex (buf) {
  return buf && buf.toString('hex')
}
