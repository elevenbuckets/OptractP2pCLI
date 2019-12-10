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

# rm build dir (pyarmor)
resource_dir = os.path.join(basedir, 'resources')
tmp_folders = [ os.path.join(resource_dir, 'dist'),
                os.path.join(resource_dir, 'build') ]
for _ in tmp_folders:
    if os.path.exists(_):
        shutil.rmtree(_)

# create node_modules.tar  (use relative path)
print('# pack node_modules')
with tarfile.open('dist/node_modules.tar', 'w') as tar:
    tar.add('node_modules')

# copy files: executables, lib/, nativeApp
print('# copy files')
shutil.copytree(os.path.join(basedir, 'resources', 'bin_win64'),
                os.path.join(basedir, 'dist', 'bin'))
shutil.copytree(os.path.join(basedir, 'lib'),
                os.path.join(basedir, 'dist', 'lib'))  # only copy selected files
shutil.copytree(os.path.join(basedir, 'dapps'),
                os.path.join(basedir, 'dist', 'dapps'))
shutil.copy2(os.path.join(basedir, 'resources', 'optract-win.json'),
             os.path.join(basedir, 'dist'))
shutil.copy2(os.path.join(basedir, 'resources', 'extension_id.json'),
             os.path.join(basedir, 'dist'))
shutil.copy2(os.path.join(basedir, 'resources', 'install.bat'),
             os.path.join(basedir, 'dist'))
shutil.copytree(os.path.join(basedir, 'resources', 'assets'),
                os.path.join(basedir, 'dist', 'assets'))

# pack and copy nativeApp and systray
# note: the depth (of folders) of nativeApp.exe and systray.exe are different if pack
#       with different arguments and has to update the relative path at least in
#       systray.py and nativeApp.py
# note: In windows, if use pyinstaller and subprocess.Popen(), must either redirect
#       stdin/stdout/stderr to null and use '--noconsole' for pyinstaller, or don't 
#       change the std[in/out/err] and don't use the '--noconsole' argument. It means 
#       there's always a console pop-up. See https://github.com/pyinstaller/pyinstaller/wiki/Recipe-subprocess 
print('# pack nativeApp')
os.chdir(os.path.join(basedir, 'resources'))
subprocess.check_call(["pyarmor", "pack", "nativeApp.py"])
shutil.copytree(os.path.join(basedir, 'resources', 'dist', 'nativeApp'),
                os.path.join(basedir, 'dist', 'nativeApp'))

print('# pack systray')
# subprocess.check_call(["pyarmor", "pack", "-e'--noconsole'", "systray.py"])  # "Failed to execute script" with "--noconsole"?
# shutil.copytree(os.path.join(basedir, 'resources', 'dist', 'systray'),
#                 os.path.join(basedir, 'dist', 'systray'))
# subprocess.check_call(["pyarmor", "pack", "-e", "-F --noconsole", "systray.py"])  # "Failed to execute script" with "--noconsole"?
subprocess.check_call(["pyarmor", "pack", "-e", "-F -i assets/icon.ico", "systray.py"])
# subprocess.check_call(["pyarmor", "pack", "-e", "'-F'", "systray.py"])
shutil.copy2(os.path.join(basedir, 'resources', 'dist', 'systray.exe'),
             os.path.join(basedir, 'dist'))
os.chdir(os.path.join(basedir))

# pack
package = 'OptractClient_win64'
if os.path.isfile(package):
    os.remove(package)

print('# packing...')
shutil.make_archive(package, 'zip', '.', 'dist')
# with tarfile.open(package, 'w') as tar:  # do not compress
# with tarfile.open(package, 'w:gz') as tar:
#     tar.add('dist')  # use relative path
print('Done!')
