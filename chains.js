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
        /* NOTE: to keep our contract with the volume driver, we need to read on _full_ sector boundaries!
                 So we divide the read into [up to] three parts: {preface, main, trailer}
                 This is kind of unfortunate, but in practice should often still be reasonably efficient. */
        if (targetPos.offset) chain.readSectors(targetPos.sector, Buffer(chain.sectorSize), function (e,d) {
            if (e) cb(e, 0, buffer);
            else {  // copy preface into `buffer`
                var dBeg = targetPos.offset,
                    dEnd = dBeg + buffer.length;
                d.copy(buffer, 0, dBeg, dEnd);
                if (dEnd > d.length) readMain();
                else cb(null, buffer.length, buffer);
            }
        }); else readMain();
        function readMain() {
            var prefaceLen = targetPos.offset,
                trailerLen = (buffer.length - prefaceLen) % chain.sectorSize,
                mainSector = (prefaceLen) ? targetPos.sector + 1 : targetPos.sector,
                mainBuffer = (trailerLen) ? buffer.slice(prefaceLen, -trailerLen) : buffer.slice(prefaceLen);
            if (mainBuffer.length) chain.readSectors(mainSector, mainBuffer, function (e,d) {
                if (e) cb(e, prefaceLen, buffer);
                else if (!trailerLen) cb(null, buffer.length, buffer);
                else readTrailer();
            }); else readTrailer();
            function readTrailer() {
                var trailerSector = mainSector + (mainBuffer.length % chain.sectorSize);
                chain.readSectors(trailerSector, Buffer(chain.sectorSize), function (e,d) {
                    if (e) cb(e, buffer.length-trailerLen, buffer)
                    else {
                        d.copy(buffer, buffer.length-trailerLen, 0, trailerLen);
                        cb(null, buffer.length, buffer);
                    }
                });
            }
        }
    };
    
    // TODO: use bulk writes whenever possible!
    chain.writeToPosition = function (targetPos, data, cb) {
        _.log(_.log.DBG, "WRITING", data.length, "bytes at", targetPos, "in", this.toJSON(), data);
        if (typeof targetPos === 'number') targetPos = posFromOffset(targetPos);
        function _writeToChain(sec, off, data) {
            var incomplete = (off || data.length < chain.sectorSize);
            if (incomplete) chain.readSectors(sec, Buffer(chain.sectorSize), function (e, orig) {
                if (e) return cb(e);
                else if (!orig) {
                    orig = new Buffer(chain.sectorSize);
                    orig.fill(0);
                }
                data.copy(orig, off);
                data = data.slice(chain.sectorSize - off);
                chain.writeSectors(sec, orig, function (e) {
                    if (e) cb(e);
                    else if (data.length) _writeToChain(sec+1, 0, data);
                    else cb(null);
                });
            }); else chain.writeSectors(sec, data.slice(0, chain.sectorSize), function (e) {
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
    
    function expandChainToLength(clusterCount, cb) {
        if (!_cacheIsComplete()) throw Error("Must be called only when cache is complete!");
        else cache.pop();            // remove 'eof' entry until finished
        
        function addCluster(clustersNeeded, lastCluster) {
            if (!clustersNeeded) cache.push('eof'), cb();
            else vol.allocateInFAT(lastCluster, function (e, newCluster) {
                if (e) cb(e);
                else vol.storeToFAT(lastCluster, newCluster, function (e) {
                    if (e) return cb(e);
                    
                    cache.push(newCluster);
                    addCluster(clustersNeeded-1, newCluster);
                });
            });
        }
        addCluster(clusterCount - cache.length, cache[cache.length - 1]);
    }
    
    function shrinkChainToLength(clusterCount, cb) {
        if (!_cacheIsComplete()) throw Error("Must be called only when cache is complete!");
        else cache.pop();            // remove 'eof' entry until finished
        
        function removeClusters(count, cb) {
            if (!count) cache.push('eof'), cb();
            else vol.storeToFAT(cache.pop(), 'free', function (e) {
                if (e) cb(e);
                else removeClusters(count - 1, cb);
            });
        }
        // NOTE: for now, we don't remove the firstCluster ourselves; we should though!
        if (clusterCount) removeClusters(cache.length - clusterCount, cb);
        else removeClusters(cache.length - 1, cb);
    }
    
    function firstSectorOfClusterAtIdx(i, alloc, cb) {
        extendCacheToInclude(i, function (e,c) {
            if (e) cb(e);
            else if (c === 'eof') {
                if (alloc) expandChainToLength(i+1, function (e) {
                    if (e) cb(e);
                    else firstSectorOfClusterAtIdx(i, false, cb);
                });
                else cb(null, -1);
            }
            else cb(null, vol._firstSectorOfCluster(c));
        });
    }
    
    chain.readSectors = function (i, dest, cb) {
        var o = i % vol._sectorsPerCluster,
            c = (i - o) / vol._sectorsPerCluster;
        if (dest.length > vol._sectorSize * vol._sectorsPerCluster) {
            // TODO: figure out which contiguous chunks need fetching
            console.warn("Trying to read", dest.length, "bytes, more than a single cluster!");
            throw S.err._TODO();
        }
        firstSectorOfClusterAtIdx(c, false, function (e,s) {
            if (e) cb(e);
            else if (s >= 0) vol._readSectors(s+o, dest, cb);
            else _pastEOF(cb);
        });
    };
    
    // TODO: does this handle NOSPC condition?
    chain.writeSectors = function (i, data, cb) {
        var o = i % vol._sectorsPerCluster,
            c = (i - o) / vol._sectorsPerCluster;
        if (data.length > vol._sectorSize * vol._sectorsPerCluster) {
            // TODO: figure out which contiguous chunks need writing
            throw S.err._TODO();
        }
        firstSectorOfClusterAtIdx(c, true, function (e,s) {
            if (e) cb(e);
            else if (s < 0) cb(S.err.IO());
            else vol._writeSectors(s+o, data, cb);
        });
    };
    
    chain.truncate = function (numSectors, cb) {
        extendCacheToInclude(Infinity, function (e,c) {
            if (e) return cb(e);
            
            var currentLength = cache.length-1,
                clustersNeeded = Math.ceil(numSectors / vol._sectorsPerCluster);
            if (clustersNeeded < currentLength) shrinkChainToLength(clustersNeeded, cb);
            else if (clustersNeeded > currentLength) expandChainToLength(clustersNeeded, cb);
            else cb();
        });
    };
    
    
    chain.toJSON = function () {
        return {firstCluster:firstCluster};
    };
    
    return chain;
};

exports.sectorChain = function (vol, firstSector, numSectors) {
    var chain = _baseChain(vol);
    
    chain.readSectors = function (i, dest, cb) {
        if (i < numSectors) vol._readSectors(firstSector+i, dest, cb);
        else _pastEOF(cb);
    };
    
    chain.writeSectors = function (i, data, cb) {
        if (i < numSectors) vol._writeSectors(firstSector+i, data, cb);
        else _.delayedCall(cb, S.err.NOSPC());
    };
    
    chain.truncate = function (i, cb) {
        _.delayedCall(cb, S.err.INVAL());
    };
    
    chain.toJSON = function () {
        return {firstSector:firstSector, numSectors:numSectors};
    };
    
    return chain;
};

// NOTE: used with mixed feelings, broken out to mark uses
function _pastEOF(cb) { _.delayedCall(cb, null, null); }
