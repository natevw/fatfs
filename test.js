var type = process.argv[2],
    uniq = Math.random().toString(36).slice(2),
    IMG = require('os').tmpdir()+"fatfs-test-"+uniq+".img";
if (!type) throw "Usage: node test [FAT12|FAT16|FAT32|ExFAT|…]";

require('child_process').exec("./make_sample.sh "+JSON.stringify(IMG)+" "+JSON.stringify(type), function (e,out,err) {
    if (e) throw e;
    console.warn(err.toString());
    //console.log(out.toString());
    
    var fatfs = require("./index.js"),
        vol = require("./img_volume.js").createDriverSync(IMG),
        fs = fatfs.createFileSystem(vol);
    require('fs').unlink(IMG, function (e) {
        if (e) console.warn("Error cleaning up test image", e);
    });
    
    fs.readdir("/", function (e,d) {
        if (e) console.error("Couldn't read directory:", e);
        else console.log("Root directory contents:", d);
    });
});




