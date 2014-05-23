var type = process.argv[2],
    uniq = Math.random().toString(36).slice(2),
    IMG = require('os').tmpdir()+"fatfs-test-"+uniq+".img";
if (!type) throw "Usage: node test [FAT12|FAT16|FAT32|ExFAT|…]";

if (type[0] === '/') startTests(type);
else require('child_process').exec("./make_sample.sh "+JSON.stringify(IMG)+" "+JSON.stringify(type), function (e,out,err) {
    if (e) throw e;
    console.warn(err.toString());
    //console.log(out.toString());
    startTests(IMG);
    require('fs').unlink(IMG, function (e) {
        if (e) console.warn("Error cleaning up test image", e);
    });
});

function startTests(imagePath) {
    var fatfs = require("./index.js"),
        vol = require("./img_volume.js").createDriverSync(imagePath),
        fs = fatfs.createFileSystem(vol);
setTimeout(function () {            // HACK: should wait for 'ready' event or something (not implemented)
    fs.readFile("/TEST/FILE.TXT", function (e,d) {
        if (e) console.error("Couldn't read file:", e);
        else console.log("File contents of", d.length, "bytes:", d.toString());
    });
    
//    fs.writeFile("/test/new file.txt", "This is Zombocom", function (e,d) {
//        if (e) console.error("Couldn't write file:", e);
//        else console.log("Wrote it!");
//    });
    
}, 1e3);
}




