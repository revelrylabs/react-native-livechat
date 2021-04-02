import React, { Component } from 'react'
import { Dimensions, Image, StyleSheet, View } from 'react-native'
import PropTypes from 'prop-types'
import ChatBubble from './components/ChatBubble'
import Chat from './components/Chat'
import { AuthWebView } from '@livechat/customer-auth'
import { init as CustomerSdkInit } from '@livechat/customer-sdk'
import * as lc3Parsers from './lc3Parsers'

const chatIcon = require('./../assets/chat.png')
const { width } = Dimensions.get('window')

export default class LiveChat extends Component {
	constructor(props) {
		super(props)
		this.defineStyles()

		this.state = {
			isChatOn: false,
			protocol: 'lc3',
			messages: [],
			users: {},
			queued: false,
			queueData: {},
			isTyping: false,
			onlineStatus: false,
			connectionState: 'not_connected',
			bubble: props.bubble ? (
				props.bubble
			) : (
				<View style={this.styles.bubbleStyle}>
					<Image source={chatIcon} style={this.styles.icon} />
				</View>
			),
		}
	}

	componentDidMount() {
		this.init()
	}

	init() {
		this.initCustomerSdk({
			licenseId: this.props.license,
			clientId: this.props.clientId,
			redirectUri: this.props.redirectUri,
		})
	}

	getCustomer = () => {
		const customerId = Object.keys(this.state.users).find((userId) => this.state.users[userId].type === 'customer')
		return this.state.users[customerId]
	}

	getUser = (id) => {
		const userId = Object.keys(this.state.users).find((_userId) => _userId === id)
		return this.state.users[userId]
	}

	addSystemMessage = (text) => {
		this.setState({
			messages: [
				...this.state.messages,
				{
					text,
					_id: String(Math.random()),
					createdAt: Date.now(),
					user: {
						_id: 'system',
					},
					system: true,
				},
			],
		})
	}

	updateEvent = (id, data) => {
		const eventIndex = this.state.messages.findIndex(({ _id }) => _id === id)
		this.setState({
			messages: [
				...this.state.messages.map((_event, index) => {
					if (index !== eventIndex) {
						return _event
					}
					return {
						...this.state.messages[eventIndex],
						...data,
					}
				}),
			],
		})
	}

	handleInputChange = (text) => {
		if (!this.state.chatId) {
			return
		}
		this.customerSDK.setSneakPeek({
			chatId: this.state.chatId,
			sneakPeekText: text,
		})
	}

	sendNewMessageLc3 = (message, quickReply, customId) => {
		let postBack = null
		if (quickReply) {
			const sourceEvent = this.state.messages.find((_message) => _message._id === quickReply.messageId)
			postBack = {
				id: quickReply.postback,
				type: 'message',
				value: quickReply.value,
				event_id: sourceEvent._id,
				thread_id: sourceEvent.thread,
			}
		}
		const newEvent = {
			type: 'message',
			text: message,
			customId,
			...(postBack && { postBack }),
		}
		if (!this.state.chatId) {
			return this.customerSDK
				.startChat({
					chat: {
						thread: {
							events: [newEvent],
						},
					},
					continuous: true,
				})
				.then((chat) => {
					this.setState({
						chatId: chat.chat,
						chatActive: true,
					})
				})
		}
		if (!this.state.chatActive) {
			return this.customerSDK
				.activateChat({
					chat: {
						id: this.state.chatId,
						thread: {
							events: [newEvent],
						},
					},
					continuous: true,
				})
				.then(() => {
					this.setState({
						chatActive: true,
					})
				})
		}
		return this.customerSDK.sendEvent({
			chatId: this.state.chatId,
			event: newEvent,
		})
	}

	isBackgroundMessage = (parsedMessage) => {
		return !this.state.isChatOn &&
			this.props.onBackgroundMessage &&
			parsedMessage.user &&
			parsedMessage.user.type === 'agent'
	}

	requiresRestart = (rawEvent) => {
		return rawEvent.type === 'system_message' && rawEvent.systemMessageType === 'manual_archived_agent'
	}

	reInit = () => {
		this.init()
	}


	handleSendMessage = (message, quickReply) => {
		const newEventId = String(Math.random())
		this.setState({
			messages: [
				...this.state.messages,
				{
					_id: newEventId,
					user: {
						_id: this.getCustomer()._id,
					},
					createdAt: Date.now(),
					text: message,
					pending: true,
				},
			],
		})
		let sendMessagePromise

		sendMessagePromise = this.sendNewMessageLc3(message, quickReply, newEventId)

		sendMessagePromise
			.then(() => {
				this.updateEvent(newEventId, {
					sent: true,
					pending: false,
				})
			})
			.catch(() => {
				this.addSystemMessage('Sending message failed')
			})
	}

	initCustomerSdk({ licenseId, clientId, redirectUri }) {
		const config = {
			licenseId: Number(licenseId, 10),
			clientId,
			redirectUri,
		}
		if (this.props.group !== null) {
			config.groupId = this.props.group
		}

		const customerSDK = CustomerSdkInit(config)
		this.customerSDK = customerSDK
		customerSDK.on('incoming_event', ({ event }) => {
			const hasEvent = this.state.messages.some(
				(_stateEvent) => _stateEvent._id === event.id || _stateEvent._id === event.customId,
			)
			if (hasEvent) {
				return
			}
			const parsed = lc3Parsers.parseEvent(event, this.getUser(event.authorId))
			if (parsed) {
				if (this.isBackgroundMessage(parsed)) {
					this.props.onBackgroundMessage(parsed)
				}

				if (this.requiresRestart(event)) {
					this.reInit()
				}

				this.setState({
					messages: [...this.state.messages, parsed],
					isTyping: false,
				})
			}
		})
		customerSDK.on('user_data', (user) => {
			this.setState({
				users: {
					...this.state.users,
					[user.id]: lc3Parsers.parseUserData(user),
				},
			})
		})
		customerSDK.on('incoming_typing_indicator', ({ typingIndicator }) => {
			this.setState({
				isTyping: typingIndicator.isTyping,
			})
		})
		customerSDK.on('availability_updated', (data) => {
			const { availability } = data
			this.setState({
				onlineStatus: availability === 'online',
			})
		})
		customerSDK.on('customer_id', (customerId) => {
			this.setState({
				users: {
					...this.state.users,
					[customerId]: {
						_id: customerId,
						type: 'customer',
						name: 'Customer',
					},
				},
			})
		})
		customerSDK.on('connected', ({ availability }) => {
			this.setState({
				connectionState: 'connected',
				onlineStatus: availability === 'online',
			})

			customerSDK.updateCustomer(this.props.customerData)
			customerSDK.listChats().then((data) => {
				const { chatsSummary, totalChats } = data
				if (totalChats) {
					this.setState({
						chatId: chatsSummary[0].id,
						chatActive: chatsSummary[0].active,
					})
					customerSDK
						.getChatHistory({ chatId: chatsSummary[0].id })
						.next()
						.then((historyData) => {
							const { value} = historyData
							const newThreadEvents = value.threads.map((thread) => {
								const { events } = thread
								const newEvents = events.filter(
									({ id }) => !this.state.messages.some((_stateEvent) => _stateEvent._id === id),
								)
								return {
									events: newEvents,
								}
							})
							const eventsToAdd = newThreadEvents.reduce((acc, current) => {
								return [...acc, ...current.events]
							}, [])
							if (!eventsToAdd) {
								return
							}
							const parsed = eventsToAdd
								.map((_event) => {
									return lc3Parsers.parseEvent(_event, this.getUser(_event.authorId))
								})
								.filter(Boolean)
							this.setState({
								messages: [...parsed, ...this.state.messages],
							})
						})
				}
			})
		})
		customerSDK.on('connection_lost', () => {
			this.setState({
				connectionState: 'connection_lost',
			})
		})
		customerSDK.on('disconnected', () => {
			this.setState({
				connectionState: 'disconnected',
			})
		})

		customerSDK.on('thread_closed', () => {
			this.setState({
				chatActive: false,
			})
		})

		customerSDK.on('incoming_chat_thread', () => {
			this.setState({
				chatActive: true,
			})
		})
	}

	defineStyles = () => {
		this.styles = StyleSheet.create({
			bubbleStyle: {
				width: width / 6,
				height: width / 6,
				backgroundColor: this.props.bubbleColor,
				borderRadius: width / 12,
				alignItems: 'center',
				justifyContent: 'center',
			},
			icon: {
				width: width / 10,
				height: width / 10,
			},
		})
	}

	openChat = () => {
		this.setState({ isChatOn: true })
	}

	closeChat = () => {
		this.setState({ isChatOn: false })
	}

	getHeaderText = () => {
		if (this.state.messages.length && this.state.chatActive) {
			return null
		}
		return this.state.onlineStatus ? this.props.greeting : this.props.noAgents
	}

	shouldDisableComposer = () => {
		if (!this.state.onlineStatus && !this.state.chatActive && !this.props.allowOfflineMessages) {
			return true
		}
		if (this.state.queued) {
			return true
		}
		return this.state.connectionState !== 'connected'
	}

	render() {
		const { isChatOn } = this.state

		return [
			<ChatBubble
				key='bubble'
				openChat={this.openChat}
				bubble={this.state.bubble}
				disabled={this.props.movable}
				styles={this.props.bubbleStyles}
			/>,
			(
				<Chat
					key='chat'
					{...this.props}
					isChatOn={isChatOn}
					closeChat={this.closeChat}
					handleSendMessage={this.handleSendMessage}
					messages={this.state.messages}
					users={this.state.users}
					customer={this.getCustomer()}
					isTyping={this.state.isTyping}
					onQuickReply={(data) => this.handleSendMessage(data[0].title, data[0])}
					onlineStatus={this.state.onlineStatus}
					connectionState={this.state.connectionState}
					onInputChange={this.handleInputChange}
					disableComposer={this.shouldDisableComposer()}
					headerText={this.getHeaderText()}
					NavBarComponent={this.props.NavBarComponent}
				/>
			),
			<View><AuthWebView style={{position: 'absolute', top: 5000, left: 5000, opacity: 0}} key="auth" /></View>,
		]
	}
}

LiveChat.propTypes = {
	license: PropTypes.string.isRequired,
	movable: PropTypes.bool,
	bubble: PropTypes.element,
	bubbleColor: PropTypes.string,
	bubbleStyles: PropTypes.object,
	chatTitle: PropTypes.string,
	greeting: PropTypes.string,
	noAgents: PropTypes.string,
	onLoaded: PropTypes.func,
	clientId: PropTypes.string,
	redirectUri: PropTypes.string,
	customerData: PropTypes.object,
	onBackgroundMessage: PropTypes.func,
	NavBarComponent: PropTypes.elementType,
}

LiveChat.defaultProps = {
	bubbleColor: '#F4511D',
	bubbleStyles: {
		position: 'absolute',
		bottom: 12,
		right: 12,
	},
	movable: true,
	group: 0,
	chatTitle: 'Chat with us!',
	greeting: 'Welcome to our LiveChat!\nHow may We help you?',
	noAgents: 'Our agents are not available right now.',
	customerData: {name:'User', email:"someone@somewhere.com"},
	allowOfflineMessages: false
}
