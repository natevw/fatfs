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
    
    var sectorCache = vol._makeCache();
    Object.defineProperty(chain, 'cacheAdvice', {
        enumerable: true,
        get: function () { return sectorCache.advice(); },
        set: function (v) { sectorCache.advice(v); }
    });
    chain._vol_readSectors = vol._readSectors.bind(vol, sectorCache);
    chain._vol_writeSectors = vol._writeSectors.bind(vol, sectorCache);
    
    chain.readFromPosition = function (targetPos, buffer, cb) {
        if (typeof targetPos === 'number') targetPos = posFromOffset(targetPos);
        if (typeof buffer === 'number') buffer = new Buffer(buffer);
        /* NOTE: to keep our contract with the volume driver, we need to read on _full_ sector boundaries!
                 So we divide the read into [up to] three parts: {preface, main, trailer}
                 This is kind of unfortunate, but in practice should often still be reasonably efficient. */
        if (targetPos.offset) chain.readSectors(targetPos.sector, Buffer(chain.sectorSize), function (e,d) {
            if (e || !d) cb(e, 0, buffer);
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
                if (e || !d) cb(e, prefaceLen, buffer);
                else if (!trailerLen) cb(null, buffer.length, buffer);
                else readTrailer();
            }); else readTrailer();
            function readTrailer() {
                var trailerSector = mainSector + (mainBuffer.length / chain.sectorSize);
                chain.readSectors(trailerSector, Buffer(chain.sectorSize), function (e,d) {
                    if (e || !d) cb(e, buffer.length-trailerLen, buffer);
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
    
    // [{firstSector,numSectors},{firstSector,numSectors},…]
    function determineSectorGroups(sectorIdx, numSectors, alloc, cb) {
        var sectorOffset = sectorIdx % vol._sectorsPerCluster,
            clusterIdx = (sectorIdx - sectorOffset) / vol._sectorsPerCluster,
            numClusters = Math.ceil((numSectors + sectorOffset) / vol._sectorsPerCluster),
            chainLength = clusterIdx + numClusters;
        extendCacheToInclude(chainLength-1, function (e,c) {
            if (e) cb(e);
            else if (c === 'eof' && alloc) expandChainToLength(chainLength, function (e) {
                if (e) cb(e);
                else _determineSectorGroups();
            });
            else _determineSectorGroups();
        });
        function _determineSectorGroups() {
            // …now we have a complete cache
            var groups = [],
                _group = null;
            for (var i = clusterIdx; i < chainLength; ++i) {
                var c = (i < cache.length) ? cache[i] : 'eof';
                if (c === 'eof') break;
                else if (_group && c !== _group._nextCluster) {
                    groups.push(_group);
                    _group = null;
                }
                if (!_group) _group = {
                   _nextCluster: c+1,
                   firstSector: vol._firstSectorOfCluster(c) + sectorOffset,
                   numSectors: vol._sectorsPerCluster - sectorOffset
                }; else {
                    _group._nextCluster += 1;
                    _group.numSectors += vol._sectorsPerCluster;
                }
                sectorOffset = 0;       // only first group is offset
            }
            if (_group) groups.push(_group);
            cb(null, groups, i === chainLength);
        }
    }
    
    chain.readSectors = function (i, dest, cb) {
        var groupOffset = 0, groupsPending;
        determineSectorGroups(i, dest.length / chain.sectorSize, false, function (e, groups, complete) {
            if (e) cb(e);
            else if (!complete) groupsPending = -1, _pastEOF(cb);
            else groupsPending = groups.length, groups.forEach(function (group) {
                var groupLength = group.numSectors * chain.sectorSize,
                    groupBuffer = dest.slice(groupOffset, groupOffset += groupLength);
                chain._vol_readSectors(group.firstSector, groupBuffer, function (e,d) {
                    if (e && groupsPending !== -1) groupsPending = -1, cb(e);
                    else if (--groupsPending === 0) cb(null, dest);
                });
            });
            if (!groupsPending) cb(null, dest);     // 0-length destination case
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
            else chain._vol_writeSectors(s+o, data, cb);
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
        if (i < numSectors) chain._vol_readSectors(firstSector+i, dest, cb);
        else _pastEOF(cb);
    };
    
    chain.writeSectors = function (i, data, cb) {
        if (i < numSectors) chain._vol_writeSectors(firstSector+i, data, cb);
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
