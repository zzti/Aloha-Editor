/**
 * html/mutation.js is part of Aloha Editor project http://aloha-editor.org
 *
 * Aloha Editor is a WYSIWYG HTML5 inline editing library and editor.
 * Copyright (c) 2010-2014 Gentics Software GmbH, Vienna, Austria.
 * Contributors http://aloha-editor.org/contribution.php
 */
define([
	'html/elements',
	'html/styles',
	'html/traversing',
	'html/predicates',
	'dom',
	'mutation',
	'arrays',
	'content',
	'boundaries',
	'overrides',
	'functions',
	'browsers'
], function HtmlMutation(
	Elements,
	Styles,
	Traversing,
	Predicates,
	Dom,
	Mutation,
	Arrays,
	Content,
	Boundaries,
	Overrides,
	Fn,
	Browsers
) {
	'use strict';

	/**
	 * Get the first ancestor element that is editable, beginning at the given
	 * node and climbing up through the ancestors tree.
	 *
	 * @private
	 * @param  {Node} node
	 * @return {boolean}
	 */
	function closestEditable(node) {
		return Dom.upWhile(node, Fn.complement(Dom.isContentEditable));
	}

	/**
	 * "Props up" the given element if needed.
	 *
	 * The HTML specification specifies that empty block-level elements be not
	 * rendered.  This becomes a problem if an editing operation results in one
	 * of these elements being emptied of all its child nodes.  If this were to
	 * happen, standard conformant browsers will no longer render that empty
	 * block element even though it will remain in the document.  Because the
	 * element is invisible, it will no longer be possible for the caret to be
	 * placed into it.
	 *
	 * In order to prevent littering the editable with invisible block-level
	 * elements, we prop them up by ensuring the empty block-level elements are
	 * given a <br> child node to force them to be rendered with one line
	 * height.
	 *
	 * The notable exception to this rule are the Microsoft's non-standard
	 * conformant Trident engines which render empty editable block level
	 * elements with one line height.
	 *
	 * @param {Element} elem
	 */
	function prop(elem) {
		if (!Predicates.isBlockNode(elem) || (Browsers.msie && closestEditable(elem))) {
			return;
		}
		if (!elem.firstChild || !Dom.nextWhile(elem.firstChild, Elements.isUnrenderedWhitespace)) {
			Dom.insert(elem.ownerDocument.createElement('br'), elem, true);
		}
	}

	/**
	 * Creates a function that will insert the nodes that are passed to it at
	 * the given boundary, if it is valid to do so.
	 *
	 * Returns true unless insertion fails because it is deemed invalid.
	 *
	 * @private
	 * @param  {Boundary} boundary
	 * @return {function(Node, OutParameter):boolean}
	 */
	function createTransferFunction(boundary) {
		var ref = Boundaries.nextNode(boundary);
		var atEnd = Boundaries.isAtEnd(boundary);
		if (Dom.isTextNode(ref)) {
			ref = ref.parentNode;
		}
		return function insert(node, out_inserted) {
			if (ref === node) {
				return out_inserted(true);
			}
			if (ref.nodeName === node.nodeName) {
				Dom.merge(ref, node);
				return out_inserted(true);
			}
			var parent = atEnd ? ref : ref.parentNode;
			if (Content.allowsNesting(parent.nodeName, node.nodeName)) {
				Dom.insert(node, ref, atEnd);
				Dom.merge(node.previousSibling, node);
				return out_inserted(true);
			}
			return out_inserted(false);
		};
	}

	/**
	 * Whether the given node can be removed.
	 *
	 * @private
	 * @param  {Node} node
	 * @param  {OutParameter(boolean):boolean} out_continueMoving
	 * @return {boolean}
	 */
	function cannotMove(node, out_continueMoving) {
		return !out_continueMoving() || !Styles.hasLinebreakingStyle(node);
	}

	/**
	 * Finds the closest line-breaking node between `above` and `below` in
	 * document order.
	 *
	 * @private
	 * @param  {Boundary} above
	 * @param  {Boundary} below
	 * @return {Boundary}
	 */
	function nextLineBreak(above, below) {
		return Boundaries.nextWhile(above, function (boundary) {
			if (Boundaries.equals(boundary, below)) {
				return false;
			}
			if (Styles.hasLinebreakingStyle(Boundaries.nextNode(boundary))) {
				return false;
			}
			if (!Boundaries.isAtEnd(boundary)) {
				return true;
			}
			return !Dom.isEditingHost(Boundaries.container(boundary));
		});
	}

	/**
	 * Determine whether the boundary `left` is visually adjacent to `right`.
	 *
	 * @private
	 * @param  {Boundary} left
	 * @param  {Boundary} right
	 * @return {boolean}
	 */
	function isVisuallyAdjacent(left, right) {
		var adjacent = false;
		Boundaries.prevWhile(right, function (pos) {
			if (Boundaries.equals(left, pos)) {
				adjacent = true;
				return false;
			}
			if (Boundaries.offset(pos) > 0) {
				// TODO:
				// var node = Boundaries.nodeBefore(pos);
				var node = Dom.nodeAtOffset(
					Boundaries.container(pos),
					Boundaries.offset(pos) - 1
				);
				if ((Dom.isTextNode(node) || Predicates.isVoidNode(node)) && Elements.isRendered(node)) {
					adjacent = false;
					return false;
				}
			}
			return true;
		});
		return adjacent;
	}

	/**
	 * Checks whether the given node has any rendered children inside of it.
	 *
	 * @private
	 * @param  {Node} node
	 * @return {boolean}
	 */
	function hasRenderedContent(node) {
		if (Dom.isTextNode(node)) {
			return Elements.isRendered(node);
		}
		var children = Dom.children(node).filter(function (node) {
			return Elements.isListItem(node) || Elements.isRendered(node);
		});
		return children.length > 0;
	}

	/**
	 * Removes the visual line break between the adjacent boundaries `above`
	 * and `below` by moving the nodes after `below` over to before `above`.
	 *
	 * @param  {Boundary} above
	 * @param  {Boundary} below
	 * @return {Arrays.<Array.<string, boolean|string>>} Overrides
	 */
	function removeBreak(above, below) {
		var right = Boundaries.nextNode(below);
		var overrides = Overrides.harvest(right);
		if (!isVisuallyAdjacent(above, below)) {
			return overrides;
		}
		var linebreak = nextLineBreak(above, below);
		var isVisibleNode = function (node) {
			return Boundaries.container(above) === node || hasRenderedContent(node);
		};
		if (Boundaries.equals(linebreak, below)) {
			Dom.climbUntil(right, Dom.remove, isVisibleNode);
			return overrides;
		}
		var moveNodeBeforeBoundary = function (boundary, node) {
			return Mutation.insertNodeAtBoundary(node, boundary, true);
		};
		var parent = right.parentNode;
		var nodes = Dom.nextSiblings(right, Styles.hasLinebreakingStyle);
		if (0 === nodes.length) {
			parent = right;
		}
		var boundary = nodes.reduce(moveNodeBeforeBoundary, linebreak);
		if (parent) {
			Dom.climbUntil(parent, Dom.remove, isVisibleNode);
		}
		return overrides;
	}

	function determineBreakingNode(context, container) {
		var name;
		if (context && context.settings && context.settings.defaultBlockNodeName) {
		    name = context.settings.defaultBlockNodeName;
		} else {
			name = 'div';
		}
		return Content.allowsNesting(container.nodeName, name) ? name : null;
	}

	/**
	 * Checks whether that the given node is a line breaking node.
	 *
	 * @private
	 * @param  {Node} node
	 * @return {boolean}
	 */
	function isBreakingContainer(node) {
		return !Predicates.isVoidNode(node)
		    && (Styles.hasLinebreakingStyle(node) || Dom.isEditingHost(node));
	}

	/**
	 * Checks whether the given node is an unrendered text node.
	 *
	 * @private
	 * @param {Node} node
	 * @return {boolean}
	 */
	function isUnrenderedTextNode(node) {
		return Dom.isTextNode(node) && Elements.isUnrendered(node);
	}

	/**
	 * Wraps `ref` into `wrapper` element.
	 *
	 * @private
	 * @param {Node}    node
	 * @param {Element} wrapper
	 */
	function wrapWithBreakingNode(ref, wrapper, context) {
		var first = Dom.prevWhile(ref, function (node) {
			return node.previousSibling
			    && Styles.hasInlineStyle(node.previousSibling);
		});
		if (first) {
			Dom.wrap(first, wrapper);
			var siblings = Dom.nextSiblings(first.nextSibling, function (node) {
				return node === ref;
			});
			Dom.move(siblings, wrapper);
			Dom.append(ref, wrapper);
		} else {
			Dom.wrap(ref, wrapper);
		}
	}

	/**
	 * Checks whether or not the given node is a significant BR element.
	 *
	 * @param  {Node} node
	 * @return {boolean}
	 */
	function isRenderedBr(node) {
		if ('BR' !== node.nodeName) {
			return false;
		}

		var ignorable = function (node) {
			return 'BR' !== node.nodeName && Elements.isUnrendered(node);
		};

		var prev = node.previousSibling
		        && Dom.prevWhile(node.previousSibling, ignorable);

		var next = node.nextSibling
		        && Dom.nextWhile(node.nextSibling, ignorable);

		// Because a br between two visible siblings in an inline node is
		// rendered
		if (prev && next && Predicates.isInlineNode(node.parentNode)) {
			return true;
		}

		// Because a br between two br or inline nodes is rendered
		if ((prev && ('BR' === prev.nodeName || !Styles.hasLinebreakingStyle(prev)))
				&&
				(next && ('BR' === next.nodeName || !Styles.hasLinebreakingStyle(next)))) {
			return true;
		}

		// Because a br next to another br will mean that both are rendered
		if ((prev && ('BR' === prev.nodeName))
				||
				(next && ('BR' === next.nodeName))) {
			return true;
		}

		// Because a br is the first space-consuming *tag* inside of a
		// line-breaking element is rendered
		var boundary = Boundaries.fromNode(node);
		while (Traversing.isAtStart(boundary)) {
			if (Styles.hasLinebreakingStyle(Boundaries.container(boundary))) {
				return true;
			}
			boundary = Boundaries.prev(boundary);
		}

		boundary = Boundaries.jumpOver(Boundaries.fromNode(node));
		while (Traversing.isAtEnd(boundary)) {
			if (Styles.hasLinebreakingStyle(Boundaries.container(boundary))) {
				return false;
			}
			boundary = Boundaries.next(boundary);
		}

		return !Styles.hasLinebreakingStyle(Traversing.nextNode(boundary));
	}

	/**
	 * Inserts a <br> element behind the given boundary position.
	 *
	 * @param  {Boundary} boundary
	 * @param  {object}
	 * @return {Boundary}
	 */
	function insertLineBreak(boundary, context) {
		var container = Boundaries.container(boundary);
		var doc = container.ownerDocument;
		var br = doc.createElement('br');
		boundary = Mutation.insertNodeAtBoundary(br, boundary, true);
		if (!isRenderedBr(br)) {
			return Mutation.insertNodeAtBoundary(doc.createElement('br'), boundary, true);
		}
		return boundary;
	}

	/**
	 * Inserts a breaking node behind the given boundary.
	 *
	 * @private
	 * @param  {Boundary} boundary
	 * @return {Boundary}
	 */
	function insertBreakingNodeBeforeBoundary(boundary, context) {
		var next = Boundaries.nextNode(boundary);
		var name = determineBreakingNode(context, next.parentNode);
		if (!name) {
			return insertLineBreak(boundary, context);
		}
		var node = next.ownerDocument.createElement(name);
		Mutation.insertNodeAtBoundary(node, boundary);
		return Boundaries.create(node, 0);
	}

	function splitBoundaryUntil(boundary, until) {
		if (until && until(boundary)) {
			return boundary;
		}
		boundary = Boundaries.normalize(boundary);
		if (Boundaries.isTextBoundary(boundary)) {
			return splitBoundaryUntil(Mutation.splitBoundary(boundary), until);
		}
		var container = Boundaries.container(boundary);
		var duplicate = Dom.cloneShallow(container);
		var node = Boundaries.nodeAfter(boundary);
		if (node) {
			Dom.move(Dom.nextSiblings(node), duplicate);
		}
		Dom.insertAfter(duplicate, container);
		return splitBoundaryUntil(Traversing.stepForward(boundary), until);
	}

	/**
	 * Inserts a visual line break after the given boundary position.
	 *
	 * Returns the "forward position".  This is the deepest node that is
	 * visually adjacent to the newly created line.
	 *
	 * @param  {Boundary} boundary
	 * @param  {Object}   context
	 * @return {Boundary}
	 */
	function insertBreak(boundary, context) {
		boundary = splitBoundaryUntil(boundary, function (boundary) {
			var node = Boundaries.container(boundary).parentNode;
			return !node
			    || Styles.hasLinebreakingStyle(node)
			    || Dom.isEditingHost(node);
		});

		boundary = Mutation.splitBoundary(boundary);

		var start = Boundaries.nextNode(boundary);

		// Because any nodes which are entirely after the boundary position
		// don't need to be copied but can be completely moved: "}<b>"
		var movable = Boundaries.isAtEnd(boundary) ? null : start;

		// Because if the boundary is right before a breaking container, The
		// the default new breaking element should be inserted right before it.
		if (movable && isBreakingContainer(movable)) {
			return insertBreakingNodeBeforeBoundary(boundary, context);
		}

		var ascend = Dom.childAndParentsUntilIncl(start, isBreakingContainer);
		var anchor = ascend.pop();

		// Because if there are no breaking containers below the editing host,
		// then we need to wrap the inline nodes adjacent to the boundary with
		// the default breaking container before attempting to split it.
		if (Dom.isEditingHost(anchor)) {
			var name = determineBreakingNode(context, anchor);
			if (!name) {
				return insertLineBreak(boundary, context);
			}
			anchor = anchor.ownerDocument.createElement(name);
			var ref = Arrays.last(ascend);
			if (ref) {
				wrapWithBreakingNode(ref, anchor, context);
			} else {
				Mutation.insertNodeAtBoundary(anchor, boundary, true);
			}
		}

		var heirarchy;
		var parent;
		var copy;
		var node;
		var next;
		var len;
		var i;

		for (i = 0, len = ascend.length; i < len; i++) {
			node = ascend[i];
			parent = Dom.cloneShallow(node.parentNode);
			copy = (node === movable) ? node : Dom.cloneShallow(node);
			next = node.nextSibling;
			Dom.append(heirarchy || copy, parent);
			if (next) {
				Dom.move(Dom.nextSiblings(next), parent);
			}
			heirarchy = parent;
		}

		if (!heirarchy) {
			heirarchy = Dom.cloneShallow(anchor);
		}

		Dom.insertAfter(heirarchy, anchor);
		prop(anchor);

		while (heirarchy && heirarchy.firstChild) {
			heirarchy = Dom.nextWhile(
				heirarchy.firstChild,
				isUnrenderedTextNode
			) || heirarchy.firstChild;
		}

		var isVisibleOrHasBreakingStyle = function (node) {
			return Styles.hasLinebreakingStyle(node) || Elements.isRendered(node);
		};

		context.overrides = context.overrides.concat(
			Overrides.harvest(heirarchy, isVisibleOrHasBreakingStyle)
		);

		var nodesToRemove = Dom.childAndParentsUntil(
			heirarchy,
			isVisibleOrHasBreakingStyle
		);

		if (nodesToRemove.length) {
			heirarchy = Arrays.last(nodesToRemove).parentNode;
			nodesToRemove.forEach(Dom.remove);
		}

		return Predicates.isVoidNode(heirarchy)
		     ? Boundaries.fromNode(heirarchy)
		     : Boundaries.create(heirarchy, 0);
	}

	return {
		prop               : prop,
		removeBreak        : removeBreak,
		insertBreak        : insertBreak,
		insertLineBreak    : insertLineBreak,
		nextLineBreak      : nextLineBreak,
		isVisuallyAdjacent : isVisuallyAdjacent,
		isRenderedBr       : isRenderedBr
	};
});
