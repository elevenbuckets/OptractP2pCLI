#!/use/bin/env python
import os
import sys
import subprocess
import shutil
import tarfile

basedir = os.path.dirname(os.path.dirname(os.path.realpath(sys.argv[0])))
os.chdir(basedir)  # important for tar files; still use absoulute path for other cases?

# mkdir dist
print('# prepare folder')
distdir = os.path.join(basedir, 'dist')
if os.path.isdir(distdir):
    shutil.rmtree(distdir)
os.mkdir(distdir)

# create node_modules.tar  (use relative path)
print('# pack node_modules')
with tarfile.open('dist/node_modules.tar', 'w') as tar:
    tar.add('node_modules')

# copy files: executables, lib/, nativeApp
print('# copy files')
shutil.copytree(os.path.join(basedir, 'resources', 'bin_win64'),
                os.path.join(basedir, 'dist', 'bin'))
shutil.copytree(os.path.join(basedir, 'lib'),
                os.path.join(basedir, 'dist', 'lib'))
shutil.copytree(os.path.join(basedir, 'dapps'),
                os.path.join(basedir, 'dist', 'dapps'))
shutil.copy2(os.path.join(basedir, 'resources', 'optract-win.json'),
             os.path.join(basedir, 'dist'))
shutil.copy2(os.path.join(basedir, 'resources', 'install.bat'),
             os.path.join(basedir, 'dist'))

# copy nativeApp.py
os.chdir(os.path.join(basedir, 'resources'))
subprocess.check_call(["pyinstaller", "-F", "nativeApp.py"])
shutil.copy2(os.path.join(basedir, 'resources', 'dist', 'nativeApp.exe'),
             os.path.join(basedir, 'dist'))
os.chdir(os.path.join(basedir))

# pack
package = 'OptractClient_win64.tar.gz'
if os.path.isfile(package):
    os.remove(package)

print('# packing...')
# with tarfile.open(package, 'w') as tar:  # use uncompres during dev only
with tarfile.open(package, 'w:gz') as tar:
    tar.add('dist')  # use relative path
print('Done!')