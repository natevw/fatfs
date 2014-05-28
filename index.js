var fifolock = require('fifolock'),
    S = require("./structs.js"),
    _ = require("./helpers.js");

exports.createFileSystem = function (volume) {
    var fs = {},
        vol = null,
        dir = require("./dir.js"),
        c = require("./chains.js"),
        q = fifolock();
    
    var GROUP = q.TRANSACTION_WRAPPER;
    
    // TODO: have our own caller pass in, or fire 'ready' event when done…
    var bootSector = new Buffer(512);
    volume.read(bootSector, 0, bootSector.length, 0, function (e) {
        if (e) throw e;
        vol = require("./vol.js").init(volume, bootSector);
        bootSector = null;          // allow GC
        fs._dirIterator = dir.iterator.bind(dir);
        fs._entryForPath = dir.entryForPath.bind(dir, vol);
        fs._updateEntry = dir.updateEntry.bind(dir, vol);
        fs._addFile = dir.addFile.bind(dir, vol);
    });
    
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
        if (!volume.write && (f.write || f.create || f.truncate)) return _.delayedCall(cb, S.err.ROFS());
        else _fd.flags = f;
        
        fs._entryForPath(path, function (e,stats,chain) {
            if (e && !(e.code === 'NOENT' && f.create && stats)) cb(e);
            else if (e) fs._addFile(chain, stats._missingFile, function (e,newStats,newChain) {
                if (e) cb(e);
                else finish(newStats, newChain);
            });
            else finish(stats,chain);
            function finish(fileStats,fileChain) {
                _fd.stats = fileStats;
                _fd.chain = fileChain;
                if (f.truncate && _fd.stats.size) {
                    // TODO: set size of file to zero…
                    cb(S.err._TODO());
                }
                // TODO: handle ISDIR/ACCES situations
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
                    else if (!d) cb(null, entryNames);
                    else {
                        if (d._name !== "." && d._name !== "..") entryNames.push(d._name);
                        processNext();
                    }
                });
            }
            processNext();
        }
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
    
    
    return fs;
}