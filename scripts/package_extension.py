"""用Python标准库生成可安装的VSIX；仅打包明确的公开扩展文件，不包含Git、测试或用户数据。"""
from pathlib import Path
import json
import zipfile
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
NS = 'http://schemas.microsoft.com/developer/vsx-schema/2011'
ET.register_namespace('', NS)


def element(tag, attributes=None):
    return ET.Element('{' + NS + '}' + tag, attributes or {})


def package(root=ROOT):
    """读取扩展清单与本地化文案，构造VSIX元数据和确定性压缩包。"""
    pkg = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    nls = json.loads((root / 'package.nls.json').read_text(encoding='utf-8'))
    def localized(value):
        return nls[value[1:-1]] if value.startswith('%') and value.endswith('%') else value
    manifest = element('PackageManifest', {'Version': '2.0.0'})
    metadata = element('Metadata')
    manifest.append(metadata)
    metadata.append(element('Identity', {'Language': 'en-US', 'Id': pkg['name'], 'Version': pkg['version'], 'Publisher': pkg['publisher']}))
    for tag, value in [('DisplayName', localized(pkg['displayName'])), ('Description', localized(pkg['description']))]:
        node = element(tag)
        node.text = value
        metadata.append(node)
    icon = 'extension/' + Path(pkg['icon']).as_posix() if pkg.get('icon') else None
    for tag, value in [('Tags', ','.join(pkg.get('keywords', []))), ('Categories', ','.join(pkg.get('categories', [])))]:
        if value:
            node = element(tag)
            node.text = value
            metadata.append(node)
    gallery_flags = element('GalleryFlags')
    gallery_flags.text = 'Public'
    metadata.append(gallery_flags)
    properties = element('Properties')
    metadata.append(properties)
    for key, value in [('Microsoft.VisualStudio.Code.Engine', pkg['engines']['vscode']), ('Microsoft.VisualStudio.Code.ExtensionKind', ','.join(pkg['extensionKind'])), ('Microsoft.VisualStudio.Code.ExtensionDependencies', ''), ('Microsoft.VisualStudio.Code.ExtensionPack', '')]:
        properties.append(element('Property', {'Id': key, 'Value': value}))
    for tag, value in [('License', 'extension/LICENSE' if pkg.get('license') else None), ('Icon', icon)]:
        if value:
            node = element(tag)
            node.text = value
            metadata.append(node)
    installation = element('Installation')
    installation.append(element('InstallationTarget', {'Id': 'Microsoft.VisualStudio.Code'}))
    manifest.append(installation)
    assets = element('Assets')
    for kind, path in [('Microsoft.VisualStudio.Code.Manifest', 'package.json'), ('Microsoft.VisualStudio.Services.Content.Details', 'README.md'), ('Microsoft.VisualStudio.Services.Content.License', 'LICENSE'), ('Microsoft.VisualStudio.Services.Content.Changelog', 'CHANGELOG.md')]:
        assets.append(element('Asset', {'Type': kind, 'Path': 'extension/' + path, 'Addressable': 'true'}))
    if icon:
        assets.append(element('Asset', {'Type': 'Microsoft.VisualStudio.Services.Icons.Default', 'Path': icon, 'Addressable': 'true'}))
    manifest.append(assets)
    contents = '''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="svg" ContentType="image/svg+xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Override PartName="/extension/LICENSE" ContentType="text/plain"/></Types>'''
    files = [root / name for name in ['package.json', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md']]
    files += sorted(root.glob('package.nls*.json'))
    files += sorted(p for p in root.glob('*.js') if not p.name.endswith('.test.js'))
    files += sorted((root / 'assets').glob('*.svg'))
    files += sorted((root / 'assets').glob('*.png'))
    for file in files:
        if not file.is_file() or file.is_symlink():
            raise ValueError('缺少公开文件或遇到符号链接：' + str(file))
    if root / pkg['main'] not in files:
        raise ValueError('扩展入口没有纳入打包')
    if pkg.get('icon') and root / pkg['icon'] not in files:
        raise ValueError('扩展图标没有纳入打包')
    dist = root / 'dist'
    dist.mkdir(exist_ok=True)
    output = dist / (pkg['name'] + '-' + pkg['version'] + '.vsix')
    def put(archive, name, data):
        # 固定压缩元数据，避免同一源码仅因时间不同生成不同安装包。
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, data)
    with zipfile.ZipFile(output, 'w') as archive:
        put(archive, 'extension.vsixmanifest', ET.tostring(manifest, encoding='utf-8', xml_declaration=True))
        put(archive, '[Content_Types].xml', contents.encode('utf-8'))
        for file in files:
            put(archive, 'extension/' + file.relative_to(root).as_posix(), file.read_bytes())
    print(output)
    return output


if __name__ == '__main__':
    package()
