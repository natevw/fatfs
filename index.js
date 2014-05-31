var streams = require('stream'),
    fifolock = require('fifolock'),
    S = require("./structs.js"),
    _ = require("./helpers.js");

exports.createFileSystem = function (volume, bootSector) {
    var fs = {},
        vol = null,
        dir = require("./dir.js"),
        c = require("./chains.js"),
        q = fifolock();
    
    var GROUP = q.TRANSACTION_WRAPPER;
    
    if (bootSector) init(bootSector);
    else volume.readSector(0, function (e,d) {
        // TODO: emit events like a decent chap… (if this interface is to be documented/public)
        if (e) throw e;
        else init(d);       
    });
    
    function init(bootSector) {
        vol = require("./vol.js").init(volume, bootSector);
        bootSector = null;          // allow GC
        fs._dirIterator = dir.iterator.bind(dir);
        fs._entryForPath = dir.entryForPath.bind(dir, vol);
        fs._updateEntry = dir.updateEntry.bind(dir, vol);
        fs._addFile = dir.addFile.bind(dir, vol);
        fs._initDir = dir.init.bind(dir, vol);
    }
    
    
    
    /**** ---- CORE API ---- ****/
    
    // NOTE: we really don't share namespace, but avoid first three anyway…
    var fileDescriptors = [null,null,null];
    
    fs.open = function (path, flags, mode, cb, _n_) { 
        if (typeof mode === 'function') {
            _n_ = cb;
            cb = mode;
            mode = 0666;
        }
    cb = GROUP(cb, function () {
        var _fd = {flags:null,stats:null,chain:null,pos:0},
            f = _.parseFlags(flags);
        if (!volume.writeSector && (f.write || f.create || f.truncate)) return _.delayedCall(cb, S.err.ROFS());
        else _fd.flags = f;
        
        fs._entryForPath(path, function (e,stats,chain) {
            if (e && !(e.code === 'NOENT' && f.create && stats)) cb(e);
            else if (e) fs._addFile(chain, stats._missingFile, {dir:f._openDir}, function (e,newStats,newChain) {
                if (e) cb(e);
                else finish(newStats, newChain);
            });
            else if (stats && f.exclusive) cb(S.err.EXIST());
            else if (stats.isDirectory() && !f._openDir) cb(S.err.ISDIR());
            else if (f.write && stats._('entry').Attr.readonly) cb(S.err.ACCES());          // TODO: use stats.mode when mappings settled
            else finish(stats,chain);
            function finish(fileStats,fileChain) {
                _fd.stats = fileStats;
                _fd.chain = fileChain;
                if (f.truncate && _fd.stats.size) {
                    var curDate = new Date();
                    fs._updateEntry(_fd.stats._('entry'), {size:0,archive:true,atime:curDate,mtime:curDate}, function (e, newEntry) {
                        if (e) cb(e);
                        else _fd.chain.truncate(1, function (e) {
                            if (e) cb(e);
                            else finish(_.makeStat(vol, newEntry), _fd.chain);
                        });
                    });
                }
                else cb(null, fileDescriptors.push(_fd)-1);
            }
        });
    }, (_n_ === '_nested_')); };
    
    fs.fstat = function (fd, cb, _n_) { cb = GROUP(cb, function () {
        var _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else _.delayedCall(cb, null, _fd.stats);
    }, (_n_ === '_nested_')); };
    
    fs.read = function (fd, buf, off, len, pos, cb, _n_) { cb = GROUP(cb, function () {
        var _fd = fileDescriptors[fd];
        if (!_fd || !_fd.flags.read) _.delayedCall(cb, S.err.BADF());
        
        var _pos = (pos === null) ? _fd.pos : pos,
            _buf = buf.slice(off,off+len);
        _fd.chain.readFromPosition(_pos, _buf, function (e,bytes,slice) {
            if (_.workaroundTessel380) _buf.copy(buf,off);        // WORKAROUND: https://github.com/tessel/beta/issues/380
            _fd.pos = _pos + bytes;
            if (e || volume.noatime) finish(e);
            else fs._updateEntry(_fd.stats._('entry'), {atime:new Date()}, finish);
            function finish(e) {
                cb(e,bytes,buf);
            }
        });
    }, (_n_ === '_nested_')); };
    
    fs._readdir = function (fd, cb, _n_)  { cb = GROUP(cb, function () {
        var _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else {
            var entryNames = [],
                getNextEntry = fs._dirIterator(_fd.chain);
            function processNext() {
                getNextEntry(function (e,d) {
                    if (e) cb(e);
                    else if (!d) cb(null, entryNames.sort());       // NOTE: sort not required, but… [simplifies tests for starters!]
                    else {
                        if (d._name !== "." && d._name !== "..") entryNames.push(d._name);
                        processNext();
                    }
                });
            }
            processNext();
        }
    }, (_n_ === '_nested_')); }
    
    fs._mkdir = function (fd, cb, _n_) { cb = GROUP(cb, function () {
        var _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else fs._initDir(_fd.chain, cb);
    }, (_n_ === '_nested_')); }
    
    fs.write = function (fd, buf, off, len, pos, cb, _n_) { cb = GROUP(cb, function () {
        var _fd = fileDescriptors[fd];
        if (!_fd || !_fd.flags.write) _.delayedCall(cb, S.err.BADF());
        
        var _pos = (pos === null) ? _fd.pos : pos,
            _buf = buf.slice(off,off+len);
        _fd.chain.writeToPosition(_pos, _buf, function (e) {
            _fd.pos = _pos + len;
            var curDate = new Date(),
                newSize = Math.max(_fd.stats.size, _fd.pos),
                newInfo = {size:newSize,archive:true,atime:curDate,mtime:curDate};
            // TODO: figure out why this silently fails on FAT12
            fs._updateEntry(_fd.stats._('entry'), newInfo, function (ee) {
                cb(e||ee, len, buf);
            });
        });
    }, (_n_ === '_nested_')); };
    
    fs.close = function (fd, cb) {
        var _fd = fileDescriptors[fd];
        if (!_fd) _.delayedCall(cb, S.err.BADF());
        else _.delayedCall(cb, fileDescriptors[fd] = null);
    };
    
    
    
    /* STREAM WRAPPERS */
    
    function _createStream(StreamType, path, opts) {
        var fd = (opts.fd !== null) ? opts.fd : '_opening_',
            pos = opts.start,
            stream = new StreamType(opts);
        
        if (fd === '_opening_') fs.open(path, opts.flags, opts.mode, function (e,fd) {
            if (e) {
                fd = '_open_error_';
                stream.emit('error', e);
            } else {
                fd = fd;
                stream.emit('open', fd);
            }
        });
        
        function autoClose(tombstone) {      // NOTE: assumes caller will clear `fd`
            if (opts.autoClose) fs.close(fd, function (e) {
                if (e) stream.emit('error', e);
                else stream.emit('close');
            });
            fd = tombstone;
        }
        
        if (StreamType === streams.Readable) {
            
            stream._read = function (n) {
                var buf;
                // TODO: optimize to fetch at least a full sector regardless of `n`…
                n = Math.min(n, opts.end-pos);
                if (fd === '_opening_') stream.once('open', function () { stream._read(n); });
                else if (pos > opts.end) stream.push(null);
                else if (n > 0) buf = new Buffer(n), fs.read(fd, buf, 0, n, pos, function (e,n,d) {
                    if (e) {
                        autoClose('_read_error_');
                        stream.emit('error', e);
                    } else stream.push((n) ? d.slice(0,n) : null);
                }), pos += n;
                else stream.push(null);
            };
            
            stream.once('end', function () {
                autoClose('_ended_');
            });
            
        } else if (StreamType === streams.Writable) {
            
            stream.bytesWritten = 0;
            
            stream._write = function (data, _enc, cb) {
                if (fd === '_opening_') stream.once('open', function () { stream._write(data, null, cb); });
                else fs.write(fd, data, 0, data.length, pos, function (e,n) {
                    if (e) {
                        autoClose('_write_error_');
                        cb(e);
                    } else {
                        stream.bytesWritten += n;
                        cb();
                    }
                }), pos += data.length;
            };
            
            stream.once('finish', function () {
                autoClose('_finished_');
            });
            
        }
else { console.error("WHATTTTTTT?", StreamType); }
        
        return stream;
    }
    
    fs.createReadStream = function (path, opts) {
        return _createStream(streams.Readable, path, _.extend({
            start: 0,
            end: Infinity,
            flags: 'r',
            mode: 0666,
            encoding: null,
            fd: null,           // ??? see https://github.com/joyent/node/issues/7708
            autoClose: true
        }, opts));
    };
    
    fs.createWriteStream = function (path, opts) {
        return _createStream(streams.Writable, path, _.extend({
            start: 0,
            flags: 'w',
            mode: 0666,
            //encoding: null,   // see https://github.com/joyent/node/issues/7710
            fd: null,           // ??? see https://github.com/joyent/node/issues/7708
            autoClose: true
        }, opts, {decodeStrings:true, objectMode:false}));
    };
    
    
    /* PATH WRAPPERS (albeit the only public interface for some folder operations) */
    
    function _fdOperation(path, opts, fn, cb) { cb = GROUP(cb, function () {
        fs.open(path, opts.flag, function (e,fd) {
            if (e) cb(e);
            else fn(fd, function () {
                var ctx = this, args = arguments;
                fs.close(fd, function (closeErr) {
                    cb.apply(ctx, args);
                }, '_nested_');
            });
        }, '_nested_');
    }); }
    
    fs.stat = fs.lstat = function (path, cb) {
        _fdOperation(path, {flag:'r'}, function (fd, cb) {
            fs.fstat(fd, cb, '_nested_');
        }, cb);
    };
    
    fs.readFile = function (path, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = 'r');
        _fdOperation(path, opts, function (fd, cb) {
            fs.fstat(fd, function (e,stat) {
                if (e) return cb(e);
                else {
                    var buffer = new Buffer(stat.size);
                    fs.read(fd, buffer, 0, buffer.length, null, function (e) {
                        if (e) cb(e);
                        else cb(null, (opts.encoding) ? buffer.toString(opts.encoding) : buffer);
                    }, '_nested_');
                }
            }, '_nested_');
        }, cb);
    };
    
    fs.writeFile = function (path, data, opts, cb) {
        if (typeof opts === 'function') {
            cb = opts;
            opts = {};
        }
        opts.flag || (opts.flag = 'w');
        _fdOperation(path, opts, function (fd, cb) {
            if (typeof data === 'string') data = new Buffer(data, opts.encoding || 'utf8');
            fs.write(fd, data, 0, data.length, null, function (e) { cb(e); }, '_nested_');
        }, cb);
    };
    
    fs.readdir = function (path, cb) {
        _fdOperation(path, {flag:'\\r'}, function (fd, cb) {
            fs._readdir(fd, cb, '_nested_');
        }, cb);
    };
    
    fs.mkdir = function (path, mode, cb) {
        if (typeof mode === 'function') {
            cb = mode;
            mode = 0777;
        }
        _fdOperation(path, {flag:'\\wx'}, function (fd, cb) {
            fs._mkdir(fd, cb, '_nested_');
        }, cb);
    }
    
    return fs;
}