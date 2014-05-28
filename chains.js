var S = require("./structs.js"),
    _ = require("./helpers.js");

function _baseChain(vol) {
    var chain = {};
    
    chain.sectorSize = vol._sectorSize;
    
    function posFromOffset(off) {
        var secSize = chain.sectorSize,
            offset = off % secSize,
            sector = (off - offset) / secSize;
        return {sector:sector, offset:offset};
    }
    
    chain.readFromPosition = function (targetPos, buffer, cb) {
        if (typeof targetPos === 'number') targetPos = posFromOffset(targetPos);
        if (typeof buffer === 'number') buffer = new Buffer(buffer);
        function _readFromChain(sec, off, bufPos) {
            chain.readSector(sec, function (e, secData) {
                if (e) return cb(e);
                else if (!secData) return cb(null, bufPos, buffer);
                
                var len = secData.length - off;
                secData.copy(buffer, bufPos, off, off+len);
                bufPos += len;
                if (bufPos < buffer.length) _readFromChain(sec+1, 0, bufPos);
                else cb(null, buffer.length, buffer);
            });
        }
        _readFromChain(targetPos.sector, targetPos.offset, 0);
    };
    
    chain.writeToPosition = function (targetPos, data, cb) {
console.log("WRITING", data.length, "bytes at", targetPos, "in", this.toJSON(), data);
console.log(Error().stack);
        if (typeof targetPos === 'number') targetPos = posFromOffset(targetPos);
        function _writeToChain(sec, off, data) {
            var incomplete = (off || data.length < chain.sectorSize);
            if (incomplete) chain.readSector(sec, function (e, orig) {
                if (e) return cb(e);
                else if (!orig) {
                    orig = new Buffer(chain.sectorSize);
                    orig.fill(0);
                }
                data.copy(orig, off);
                data = data.slice(chain.sectorSize - off);
                chain.writeSector(sec, orig, function (e) {
                    if (e) cb(e);
                    else if (data.length) _writeToChain(sec+1, 0, data);
                    else cb(null);
                });
            }); else chain.writeSector(sec, data, function (e) {
                if (e) return cb(e);
                
                data = data.slice(chain.sectorSize);
                if (data.length) _writeToChain(sec+1, 0, data);
                else cb(null);
            });
        }
        _writeToChain(targetPos.sector, targetPos.offset, data);
    };
    
    return chain;
};



exports.clusterChain = function (vol, firstCluster, _parent) {
    var chain = _baseChain(vol),
        cache = [firstCluster];
    
    // ~HACK: needed by `dir.init` for ".." entry…
    if (_parent) chain._parentChain = _parent;
    
    function _cacheIsComplete() {
        return cache[cache.length-1] === 'eof';
    }
    
    function extendCacheToInclude(i, cb) {          // NOTE: may `cb()` before returning!
        if (i < cache.length) cb(null, cache[i]);
        else if (_cacheIsComplete()) cb(null, 'eof');
        else vol.fetchFromFAT(cache[cache.length-1], function (e,d) {
            if (e) cb(e);
            else if (typeof d === 'string' && d !== 'eof') cb(S.err.IO());
            else {
                cache.push(d);
                extendCacheToInclude(i, cb);
            }
        });
    }
    
    // NOTE: returns the final cluster (same as if called `extendCacheToInclude(len)`)
    function expandChainToLength(len, cb) {
        if (!_cacheIsComplete()) throw Error("Must be called only when cache is complete!");
        else cache.pop();            // remove 'eof' entry until finished
        
        function addCluster(clustersNeeded, lastCluster) {
            vol.allocateInFAT(lastCluster, function (e, newCluster) {
                if (e) cb(e);
                else vol.storeToFAT(lastCluster, newCluster, function (e) {
                    if (e) return cb(e);
                    
                    cache.push(newCluster);
                    if (clustersNeeded) {
                        // TODO: zero-fill contents of newCluster!
                        addCluster(clustersNeeded-1, newCluster);
                    } else {
                        // NOTE: we don't zero-fill last cluster; we assume it will be written next
                        cache.push('eof');
                        cb(null, newCluster);
                    }
                });
            });
        }
        addCluster(len - cache.length, cache[cache.length - 1]);
    }
    
    function firstSectorOfClusterAtIdx(i, alloc, cb) {
        extendCacheToInclude(i, function (e,c) {
            if (e) cb(e);
            else if (c === 'eof') {
                if (alloc) expandChainToLength(i+1, function (e,c) {
                    if (e) cb(e);
                    else cb(null, vol._firstSectorOfCluster(c));
                });
                else cb(null, null);
            }
            else cb(null, vol._firstSectorOfCluster(c));
        });
    }
    
    chain.readSector = function (i, cb) {
        var o = i % vol._sectorsPerCluster,
            c = (i - o) / vol._sectorsPerCluster;
        firstSectorOfClusterAtIdx(c, false, function (e,s) {
            if (e) cb(e);
            else if (s) vol._readSector(s+o, cb);
            else _pastEOF(cb);
        });
    };
    
    // TODO: does this handle NOSPC condition?
    chain.writeSector = function (i, data, cb) {
        var o = i % vol._sectorsPerCluster,
            c = (i - o) / vol._sectorsPerCluster;
        firstSectorOfClusterAtIdx(c, true, function (e,s) {
            if (e) cb(e);
            else vol._writeSector(s+o, data, cb);
        });
    };
    
    // TODO: chain.truncate
    
    chain.toJSON = function () {
        return {firstCluster:firstCluster};
    };
    
    return chain;
};

exports.sectorChain = function (vol, firstSector, numSectors) {
    var chain = _baseChain(vol);
    
    chain.readSector = function (i, cb) {
        if (i < numSectors) vol._readSector(firstSector+i, cb);
        else _pastEOF(cb);
    };
    
    chain.writeSector = function (i, data, cb) {
        if (i < numSectors) vol._writeSector(firstSector+i, data, cb);
        else _.delayedCall(cb, S.err.NOSPC());
    };
    
    // TODO: chain.truncate
    
    chain.toJSON = function () {
        return {firstSector:firstSector, numSectors:numSectors};
    };
    
    return chain;
};

// NOTE: used with mixed feelings, broken out to mark uses
function _pastEOF(cb) { _.delayedCall(cb, null, null); }
