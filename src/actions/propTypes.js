const recast = require('recast');
const Promise = require('bluebird');
const arrayUtils = require('../utils/arrayUtils');
const PropTypes = require('../beans/PropTypes');
const propTypesHelper = require('../utils/propTypesHelper');
const setting = require('../setting');

function findPropTypes({ componentNode, propTypesNode, defaultPropsNode }, options) {
  return Promise.all([
    findPropTypesByPropsIdentity(componentNode, options), //代码生成类型
    findPropTypesInDefaultPropsNode(defaultPropsNode, options), //默认类型
    findPropTypesInPropTypeNode(propTypesNode), //优先级最高，必须确保已经填写的PropTypes级别最高
  ]).then((results) => {
    return results.reduce((total = [], current = []) => {
      return propTypesHelper.customMergePropTypes(total, current)
    }, [])
      .sort(arrayUtils.sortByKey());
  });
}

function findPropTypesByPropsIdentity(ast, options) {
  let identity;
  let propTypes = [];
  let visitOptions = {};
  if ((ast.type === 'FunctionDeclaration' || ast.type === 'ArrowFunctionExpression' || ast.type === 'FunctionExpression')
    && ast.params.length > 0
  ) {
    let firstParams = ast.params[0];
    if (firstParams.type === 'Identifier') {
      identity = ast.params[0].name;
    } else if (firstParams.type === 'ObjectPattern') {
      let newPropTypes = findAndCompletePropTypes(ast, findPropTypesInObjectPattern(firstParams, options));
      propTypes = propTypesHelper.customMergePropTypes(propTypes, newPropTypes)
    }

  } else if (ast.type === 'ClassDeclaration') {
    identity = 'this\\.props';
    visitOptions.visitMethodDefinition = function (path) {
      let node = path.node;
      if (node.key.type === 'Identifier'
        && node.key.name === 'constructor'
        && node.value.type === 'FunctionExpression'
      ) {
        let newPropTypes = findPropTypesByPropsIdentity(node.value, options);
        propTypes = propTypesHelper.customMergePropTypes(propTypes, newPropTypes)
      }
      this.traverse(path);
    };
  }

  if (identity) {
    visitOptions.visitMemberExpression = function (path) {
      let { propType } = propTypesHelper.getPropTypeByMemberExpression([identity], path);
      if (propType) {
        let newPropTypes = findAndCompletePropTypes(findBlockStatement(path), [propType]);
        propTypes = propTypesHelper.customMergePropTypes(propTypes, [propType])
      }
      this.traverse(path);
    };
  }

  visitOptions.visitVariableDeclarator = function (path) {
    let node = path.node;
    let idNode = node.id;
    let initNode = node.init;
    if (idNode && initNode && idNode.type === 'ObjectPattern') {
      if (
        (initNode.type === 'MemberExpression'
          && initNode.object.type === 'ThisExpression'
          && initNode.property.name === 'props') ||
        (initNode.type === 'Identifier' && initNode.name === identity)
      ) {
        let newPropTypes = findAndCompletePropTypes(findBlockStatement(path), findPropTypesInObjectPattern(idNode));
        propTypes = propTypesHelper.customMergePropTypes(propTypes, newPropTypes)
      }
    }
    this.traverse(path);
  };

  recast.visit(ast, visitOptions);
  return propTypes;
}

function findComponentNode(ast, options) {
  let name = options.name;
  let componentNode;
  recast.visit(ast, {
    visitClassDeclaration: function (path) {
      const node = path.node;
      if (node.id.name === name) {
        componentNode = node;
      }
      this.traverse(path);
    },
    visitFunctionDeclaration: function (path) {
      const node = path.node;
      if (node.id && node.id.type === 'Identifier' && node.id.name === name) {
        componentNode = node;
      }
      this.traverse(path);
    },
    visitArrowFunctionExpression: function (path) {
      const node = path.node;
      const parentNode = path.parentPath.node;
      if (parentNode.type === 'VariableDeclarator' && parentNode.id && parentNode.id.type === 'Identifier' && parentNode.id.name === name) {
        componentNode = node;
      }
      this.traverse(path);
    }
  });
  if (componentNode) {
    return Promise.resolve(componentNode);
  } else {
    return Promise.reject(new Error('The selected text is not a valid React Component !'));
  }
}

function findPropTypesNode(ast, options) {
  let { name, alias } = options;
  let propTypesNode;
  let propTypesClassPropertyNode;
  recast.visit(ast, {
    visitAssignmentExpression: function (path) {
      const node = path.node;
      let left = node.left;
      let right = node.right;
      if (left && left.type === 'MemberExpression'
        && left.object.type === 'Identifier'
        && left.property.type === 'Identifier'
        && left.object.name === name
        && left.property.name === (alias || 'propTypes')
        && right.type === 'ObjectExpression'
      ) {
        propTypesNode = node;
      }
      this.traverse(path);
    },
    visitClassProperty: function (path) {
      const node = path.node;
      let key = node.key;
      let value = node.value;
      if (key && value
        && key.type === 'Identifier'
        && value.type === 'ObjectExpression'
        && key.name === (alias || 'propTypes')
        && node.static) {
        let classNode = path.parentPath.parentPath.parentPath.node;
        if (classNode && classNode.type === 'ClassDeclaration'
          && classNode.id.name === name) {
          propTypesClassPropertyNode = node;
        }
      }
      this.traverse(path);
    }
  });
  if (propTypesClassPropertyNode) {
    return Promise.resolve(propTypesClassPropertyNode);
  } else if (propTypesNode) {
    return Promise.resolve(propTypesNode);
  } else {
    return Promise.resolve(null);
  }
}

function findUpdateSpecialPropTypes(typeNode, name) {
  let props = new PropTypes(name);
  let callee, calleeParams;
  if (typeNode.type === 'CallExpression') {
    callee = typeNode.callee;
    calleeParams = typeNode.arguments[0];
  } else if (typeNode.type === 'MemberExpression') {
    let object = typeNode.object;
    let property = typeNode.property;
    if (object.type === 'CallExpression') {
      callee = object.callee;
      calleeParams = object.arguments[0];
    } else if (object.type === 'MemberExpression') {
      if (object.property.name !== 'any') {
        props.type = object.property.name;
      }
    } else if (object.type === 'Identifier') {
      if (property.name !== 'any') {
        props.type = property.name;
      }
    }
    // 设置isRequired
    if (property.type === 'Identifier' && property.name === 'isRequired') {
      props.isRequired = true
    }
  } else {
    // 不符合的类型，返回null
    return null;
  }

  // 如果是特殊类型, 在这里统一处理
  if (callee && calleeParams) {
    // 设置类型
    if (callee.type === 'MemberExpression') {
      let property = callee.property;
      if (property.type === 'Identifier' && property.name !== 'any') {
        props.type = property.name;
      }
    }
    if (calleeParams.type === 'ObjectExpression') {
      // shape or exact
      props.childTypes = findPropTypesInObjectNode(calleeParams)
    } else if (calleeParams.type === 'ArrayExpression') {
      // oneOf、oneOfType
      if (props.type === 'oneOf') {
        // 保存当前的ast
        props.ast = calleeParams;
      } else {
        let elements = calleeParams.elements || [];
        props.childTypes = elements.map(item => findUpdateSpecialPropTypes(item)).filter(item => !!item);
      }
    } else if (calleeParams.type === 'MemberExpression') {
      // arrayOf、objectOf、instanceOf
      let property = calleeParams.property;
      let childType = findUpdateSpecialPropTypes(calleeParams);
      if (childType) {
        props.childTypes = [childType]
      }
    }
  }

  // 返回类型
  return props
}

function findPropTypesInObjectNode(objectNode) {
  let propTypes = [];
  if (objectNode && objectNode.type === 'ObjectExpression') {
    let properties = objectNode.properties || [];
    for (let i = 0; i < properties.length; i++) {
      let key = properties[i].key;
      let value = properties[i].value;
      propTypes.push(findUpdateSpecialPropTypes(value, key.name));
    }
  }
  return propTypes;
}

function findPropTypesInPropTypeNode(propNode) {
  if (!propNode) {
    return []
  }
  if (propNode.type === 'ClassProperty' && propNode.static) {
    return findPropTypesInObjectNode(propNode.value)
  } else if (propNode.type === 'AssignmentExpression') {
    return findPropTypesInObjectNode(propNode.right)
  } else {
    return []
  }
}

function findPropTypesInDefaultPropsNode(ast, options) {
  let propTypes = [];
  if (ast) {
    recast.visit(ast, {
      visitProperty: function (path) {
        const node = path.node;
        let key = node.key;
        let value = node.value;
        if (key && value && key.type === 'Identifier') {
          let props = new PropTypes(key.name);
          propTypesHelper.updatePropTypeByNode(value, props);
          if (props.type !== 'any') {
            props.defaultValue = recast.prettyPrint(value, setting.getCodeStyle(options)).code
          }
          propTypes.push(props);
        }
        this.traverse(path);
      }
    });
  }
  return propTypes;
}

function findPropTypesInObjectPattern(ast, options) {
  let propTypes = [];
  let properties = ast.properties || [];
  for (let i = 0; i < properties.length; i++) {
    let property = properties[i].value;
    let key = properties[i].key;
    if (property && key) {
      let props = new PropTypes(key.name);
      if (property.type === 'AssignmentPattern') {
        let left = properties[i].value.left;
        let right = properties[i].value.right;
        if (left && left.type === 'Identifier' && right) {
          propTypesHelper.updatePropTypeByNode(right, props);
          if (props.type !== 'any') {
            props.defaultValue = recast.prettyPrint(right, setting.getCodeStyle(options)).code
          }
          props.id = left.name;
          propTypes.push(props);
        }
      } else if (property.type === 'Identifier') {
        props.id = property.name;
        propTypes.push(props);
      }
    }
  }
  return propTypes;
}

// 获取当前函数的块级作用域
function findBlockStatement(path) {
  if (!path) return null;
  if (!path.parent) {
    return null;
  }
  if (path.parent.node.type === 'BlockStatement') {
    return path.parent.node;
  } else {
    return findBlockStatement(path.parent)
  }
}

function findAndCompletePropTypes(ast, propTypes) {
  let newPropTypes = propTypes.slice();
  let ids = newPropTypes
    .filter(item => !!item.id) // Must have id
    .filter(item => item.type === 'any' || item.type === 'shape') // Others not need complete
    .map(item => item.id);
  // 优化性能，减少查找次数
  if (ids.length === 0) return newPropTypes;
  if (ast) {
    recast.visit(ast, {
      visitCallExpression: function (path) {
        let node = path.node;
        let callee = node.callee;
        if (callee.type === 'Identifier' && ids.indexOf(callee.name) !== -1) {
          let updatePropType = newPropTypes.find(item => item.id === callee.name);
          if (updatePropType) {
            updatePropType.type = 'func'
          }
        }
        this.traverse(path);
      },
      visitMemberExpression: function (path) {
        let { name, propType } = propTypesHelper.getPropTypeByMemberExpression(ids, path);
        if (name && propType) {
          let updatePropType = newPropTypes.find(item => item.id === name);
          if (updatePropType) {
            let newPropTypes = findAndCompletePropTypes(ast, [propType]);
            // 这时候说明肯定是复杂类型，所以用shape
            updatePropType.type = 'shape';
            updatePropType.childTypes = propTypesHelper.customMergePropTypes(updatePropType.childTypes, newPropTypes)
          }
        }
        this.traverse(path);
      }
    });
  }
  return newPropTypes;
}

exports.findPropTypes = findPropTypes;
exports.findComponentNode = findComponentNode;
exports.findPropTypesNode = findPropTypesNode;
exports.findPropTypesInPropTypeNode = findPropTypesInPropTypeNode;
